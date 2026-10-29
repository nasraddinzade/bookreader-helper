// Фоновая очередь перевода. Прогресс хранится по предложениям (status в таблице sentences),
// поэтому после перезапуска очередь продолжает с места, а переведённое не запрашивается повторно.
// Порядок: книги по последнему открытию; внутри книги — глава, которую сейчас читают, затем следующие,
// затем пропущенные предыдущие.

import { db, getSettings, updateSettings } from '../db.js';
import { emit } from '../events.js';
import { createProvider } from '../providers/index.js';
import { matchResults, finalize, repairTokens } from '../gloss.js';

const MAX_ATTEMPTS = 3;
const AUTH_RECHECK_MS = 2 * 60 * 1000;
const RATE_WINDOW_MS = 20 * 60 * 1000;

const state = {
  status: 'idle', // idle | running | paused | limited | auth | error
  message: '',
  resumeAt: null,
  workers: 0,
  inflight: new Set(), // id предложений в работе
  active: new Map(), // workerId -> { bookId, chapter, n, since }
  log: [], // { start, end, n } — пачки, переведённые провайдером (для скорости и оценки времени)
};
let wakeTimer = null;
let workerSeq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Запросы ------------------------------------------------------------------

const booksToTranslate = db.prepare(`
  SELECT id, lang, target_lang, pos_chapter FROM books WHERE paused = 0
  ORDER BY COALESCE(opened_at, added_at) DESC`);
const pendingForBook = db.prepare(`
  SELECT s.id, s.text, s.hash, s.attempts, c.idx AS chapter
  FROM sentences s JOIN chapters c ON c.id = s.chapter_id
  WHERE s.book_id = ? AND s.status = 'pending'
  ORDER BY (c.idx < ?), c.idx, s.idx
  LIMIT ?`);
const cacheGet = db.prepare('SELECT gloss FROM gloss_cache WHERE key = ?');
const cachePut = db.prepare('INSERT OR REPLACE INTO gloss_cache (key, gloss, at) VALUES (?, ?, ?)');
const saveDone = db.prepare(`UPDATE sentences SET status = 'done', gloss = ?, error = NULL, translated_by = ? WHERE id = ?`);
const saveFail = db.prepare(`UPDATE sentences SET attempts = attempts + 1, error = ?,
  status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'error' ELSE 'pending' END WHERE id = ?`);
const chapterLeft = db.prepare(`SELECT COUNT(*) AS n FROM sentences s JOIN chapters c ON c.id = s.chapter_id
  WHERE c.book_id = ? AND c.idx = ? AND s.status != 'done'`);
const pendingCounts = db.prepare(`SELECT book_id, COUNT(*) AS n FROM sentences WHERE status = 'pending' GROUP BY book_id`);

const cacheKey = (provider, src, tgt, hash) => `${provider.name}|${src}>${tgt}|${hash}`;

// ---- Провайдер ----------------------------------------------------------------

let providerMemo = { sig: '', provider: null };
function providerFor(book) {
  const s = getSettings();
  const sig = [s.provider, s.claudeModel, s.claudeEffort, s.ollamaModel, s.ollamaThreads, book.lang, book.target_lang].join('|');
  if (providerMemo.sig !== sig) providerMemo = { sig, provider: createProvider(s, book.lang, book.target_lang) };
  return providerMemo.provider;
}

// ---- Состояние ----------------------------------------------------------------

function setStatus(status, message = '', resumeAt = null) {
  const changed = state.status !== status || state.message !== message || state.resumeAt !== resumeAt;
  state.status = status;
  state.message = message;
  state.resumeAt = resumeAt;
  if (changed) emit('queue', { status });
}

function blocked() {
  if (getSettings().translationPaused) return true;
  return state.status === 'limited' || state.status === 'auth';
}

function wakeAt(ms) {
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    if (state.status === 'limited' || state.status === 'auth') setStatus('idle');
    pump();
  }, Math.max(1000, ms - Date.now()));
}

// ---- Выбор работы -------------------------------------------------------------

function pickJob() {
  const batchSize = Math.max(1, Math.min(30, Number(getSettings().batchSize) || 12));
  for (const book of booksToTranslate.all()) {
    const rows = pendingForBook.all(book.id, book.pos_chapter, batchSize + state.inflight.size + 1)
      .filter((r) => !state.inflight.has(r.id));
    if (!rows.length) continue;
    const chapter = rows[0].chapter;
    const items = rows.filter((r) => r.chapter === chapter).slice(0, batchSize);
    return { book, chapter, items };
  }
  return null;
}

// ---- Перевод пачки -----------------------------------------------------------

function store(job, item, gloss, by, provider) {
  saveDone.run(JSON.stringify(gloss), by, item.id);
  if (provider?.cacheable && by !== 'cache') {
    cachePut.run(cacheKey(provider, job.book.lang, job.book.target_lang, item.hash), JSON.stringify(gloss), Date.now());
  }
  emit('sentence', { bookId: job.book.id, chapter: job.chapter, id: item.id });
}

function fail(job, items, message) {
  for (const it of items) saveFail.run(message.slice(0, 500), it.id);
  emit('sentence', { bookId: job.book.id, chapter: job.chapter });
}

/** Переводит items; возвращает false, если очередь надо остановить (лимит, нет входа). */
async function translateItems(job, items, provider, depth = 0) {
  const texts = items.map((i) => i.text);
  const t0 = Date.now();
  let raw;
  try {
    raw = await provider.glossBatch(texts);
  } catch (e) {
    if (e.kind === 'limit') { setStatus('limited', e.message, e.resumeAt); wakeAt(e.resumeAt); return false; }
    if (e.kind === 'auth' || e.kind === 'unavailable') { setStatus('auth', e.message); wakeAt(Date.now() + AUTH_RECHECK_MS); return false; }
    if (e.reduceBatch && items.length > 1) {
      const half = Math.ceil(items.length / 2);
      return (await translateItems(job, items.slice(0, half), provider, depth)) && translateItems(job, items.slice(half), provider, depth);
    }
    console.warn('[translate]', e.message);
    fail(job, items, e.message || String(e));
    await sleep(3000);
    return true;
  }
  state.log.push({ start: t0, end: Date.now(), n: items.length });

  const results = matchResults(texts, raw);
  const retry = [];
  items.forEach((item, k) => {
    const r = results[k] ? finalize(item.text, results[k]) : null;
    if (r?.aligned) store(job, item, r.gloss, provider.name, provider);
    else retry.push({ item, partial: r?.gloss || null });
  });
  if (!retry.length) return true;

  // Пропущенные и невыровненные: сначала новой пачкой (если их несколько), потом по одному.
  if (retry.length > 2 && depth === 0) {
    return translateItems(job, retry.map((r) => r.item), provider, depth + 1);
  }
  for (const { item, partial } of retry) {
    let best = partial;
    try {
      const again = await provider.glossBatch([item.text]);
      const m = matchResults([item.text], again)[0] || again[0];
      const r = m ? finalize(item.text, m) : null;
      if (r?.aligned) { store(job, item, r.gloss, provider.name, provider); continue; }
      if (r?.gloss) best = r.gloss;
    } catch (e) {
      if (e.kind === 'limit') { setStatus('limited', e.message, e.resumeAt); wakeAt(e.resumeAt); return false; }
      if (e.kind === 'auth' || e.kind === 'unavailable') { setStatus('auth', e.message); wakeAt(Date.now() + AUTH_RECHECK_MS); return false; }
    }
    if (best) {
      // Модель дважды нарушила правило 1 — чиним токены, чтобы строка всё равно совпадала с оригиналом.
      store(job, item, { full: best.full, tokens: repairTokens(item.text, best.tokens), repaired: true }, provider.name, provider);
    } else {
      fail(job, [item], 'Модель не вернула перевод этого предложения');
    }
  }
  return true;
}

async function runJob(job) {
  let provider;
  try {
    provider = providerFor(job.book);
  } catch (e) {
    setStatus('error', e.message);
    getSettings().translationPaused || wakeAt(Date.now() + AUTH_RECHECK_MS);
    return false;
  }
  // Кэш: одно и то же предложение тем же провайдером и моделью не переводится дважды.
  const todo = [];
  for (const item of job.items) {
    const hit = provider.cacheable ? cacheGet.get(cacheKey(provider, job.book.lang, job.book.target_lang, item.hash)) : null;
    if (hit) store(job, item, JSON.parse(hit.gloss), 'cache', provider);
    else todo.push(item);
  }
  if (!todo.length) return true;
  const ok = await translateItems(job, todo, provider);
  if (chapterLeft.get(job.book.id, job.chapter).n === 0) emit('chapter-done', { bookId: job.book.id, chapter: job.chapter });
  return ok;
}

async function worker() {
  const wid = ++workerSeq;
  state.workers++;
  try {
    for (;;) {
      if (blocked()) break;
      const job = pickJob();
      if (!job) break;
      job.items.forEach((i) => state.inflight.add(i.id));
      state.active.set(wid, { bookId: job.book.id, chapter: job.chapter, n: job.items.length, since: Date.now() });
      if (state.status !== 'running') setStatus('running');
      emit('queue', { status: 'running' });
      let ok = true;
      try {
        ok = await runJob(job);
      } catch (e) {
        console.error('[translate] job failed', e);
        fail(job, job.items, e.message || String(e));
      } finally {
        job.items.forEach((i) => state.inflight.delete(i.id));
        state.active.delete(wid);
      }
      if (!ok) break;
    }
  } finally {
    state.workers--;
    if (state.workers === 0 && state.status === 'running') {
      setStatus(getSettings().translationPaused ? 'paused' : 'idle');
    }
  }
}

/** Запускает недостающих воркеров. Вызывается при любом событии, которое может дать работу. */
export function pump() {
  if (getSettings().translationPaused) {
    if (state.status !== 'limited' && state.status !== 'auth' && state.workers === 0) setStatus('paused');
    return;
  }
  if (state.status === 'paused' || state.status === 'error') setStatus('idle');
  if (blocked()) return;
  const want = getSettings().provider === 'claude-code' ? Math.max(1, Math.min(4, Number(getSettings().parallel) || 1)) : 1;
  // Воркер без работы завершается синхронно, поэтому число запусков считаем заранее.
  const start = want - state.workers;
  for (let i = 0; i < start; i++) worker();
}

// ---- Управление и состояние для интерфейса -------------------------------------

export function pauseAll() {
  updateSettings({ translationPaused: true });
  if (state.workers === 0) setStatus('paused');
  else emit('queue', { status: state.status });
}

export function resumeAll() {
  updateSettings({ translationPaused: false });
  if (state.status === 'limited' || state.status === 'auth' || state.status === 'paused') setStatus('idle');
  pump();
}

/** Скорость перевода (предложений в минуту) по последним пачкам. */
function rate() {
  const now = Date.now();
  state.log = state.log.filter((e) => now - e.end < RATE_WINDOW_MS);
  if (!state.log.length) return null;
  const n = state.log.reduce((a, e) => a + e.n, 0);
  const span = Math.max(...state.log.map((e) => e.end)) - Math.min(...state.log.map((e) => e.start));
  return span > 0 ? (n / span) * 60000 : null;
}

export function queueStatus() {
  const perMin = rate();
  const pending = new Map(pendingCounts.all().map((r) => [r.book_id, r.n]));
  let ahead = 0;
  const books = [];
  for (const b of booksToTranslate.all()) {
    const n = pending.get(b.id) || 0;
    if (!n) continue;
    ahead += n;
    books.push({ id: b.id, pending: n, etaMin: perMin ? Math.round(ahead / perMin) : null });
  }
  return {
    status: state.status,
    message: state.message,
    resumeAt: state.resumeAt,
    paused: !!getSettings().translationPaused,
    provider: getSettings().provider,
    perMinute: perMin ? Math.round(perMin * 10) / 10 : null,
    active: [...state.active.values()],
    books,
  };
}

export function retrySentence(id) {
  db.prepare(`UPDATE sentences SET status = 'pending', attempts = 0, error = NULL WHERE id = ?`).run(id);
  pump();
}

export function retryBookErrors(bookId) {
  db.prepare(`UPDATE sentences SET status = 'pending', attempts = 0, error = NULL WHERE book_id = ? AND status = 'error'`).run(bookId);
  pump();
}

/** Перевести главу заново (например, другой моделью): сбрасывает её предложения. */
export function retranslateChapter(bookId, chapterIdx) {
  db.prepare(`UPDATE sentences SET status = 'pending', attempts = 0, error = NULL, gloss = NULL
    WHERE chapter_id = (SELECT id FROM chapters WHERE book_id = ? AND idx = ?)`).run(bookId, chapterIdx);
  emit('sentence', { bookId, chapter: chapterIdx });
  pump();
}
