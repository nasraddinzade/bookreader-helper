// Озвучка: поток с Kokoro, очередь (срочные запросы из интерфейса раньше фоновых),
// аудио по одному файлу на предложение, кэш слов и фраз, фоновая озвучка переведённых глав.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { db, getSettings } from '../db.js';
import { AUDIO_DIR, MODELS_DIR } from '../config.js';
import { emit } from '../events.js';
import { cpuHeavyTranslation } from '../queue/translate.js';

const CACHE_DIR = path.join(AUDIO_DIR, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function findFfmpeg() {
  for (const cmd of [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean)) {
    try {
      if (spawnSync(cmd, ['-hide_banner', '-version'], { windowsHide: true, timeout: 5000 }).status === 0) return cmd;
    } catch { /* нет */ }
  }
  return null;
}
const FFMPEG = findFfmpeg();

const state = {
  worker: null,
  sig: '',
  status: 'off', // off | loading | ready | error
  error: '',
  voices: [],
  queue: [], // { id, text, voice, speed, urgent, resolve, reject }
  pending: new Map(), // id -> job, отправленные в поток
  seq: 0,
  stats: [], // { genMs, duration }
  background: false,
};

function settingsSig(s = getSettings()) {
  return `${s.ttsThreads}|${s.ttsDtype}`;
}

function startWorker() {
  const s = getSettings();
  state.sig = settingsSig(s);
  state.status = 'loading';
  state.error = '';
  const w = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: {
      cacheDir: path.join(MODELS_DIR, 'hf'),
      threads: Math.max(1, Math.min(12, Number(s.ttsThreads) || 4)),
      dtype: s.ttsDtype || 'fp32',
      ffmpeg: FFMPEG,
    },
  });
  state.worker = w;
  w.on('message', (m) => {
    if (m.type === 'ready') {
      state.status = 'ready';
      state.voices = m.voices;
      emit('tts', { status: 'ready' });
      dispatch();
      backgroundLoop();
      return;
    }
    const job = state.pending.get(m.id);
    if (!job) return;
    state.pending.delete(m.id);
    if (m.type === 'done') {
      state.stats.push({ genMs: m.genMs, duration: m.duration });
      if (state.stats.length > 50) state.stats.shift();
      job.resolve({ data: Buffer.from(m.data), ext: m.ext, duration: m.duration });
    } else job.reject(new Error(m.message));
    dispatch();
  });
  w.on('error', (e) => {
    state.status = 'error';
    state.error = e.message;
    emit('tts', { status: 'error' });
    for (const job of [...state.pending.values(), ...state.queue]) job.reject(e);
    state.pending.clear();
    state.queue = [];
  });
  w.on('exit', () => { if (state.worker === w) { state.worker = null; if (state.status !== 'error') state.status = 'off'; } });
}

function ensureWorker() {
  if (state.worker && state.sig !== settingsSig()) {
    // Изменилось число потоков или точность модели — перезапуск после текущей задачи.
    if (state.pending.size === 0) { state.worker.terminate(); state.worker = null; }
  }
  if (!state.worker) startWorker();
}

function dispatch() {
  if (state.status !== 'ready' || state.pending.size > 0 || !state.queue.length) return;
  const i = state.queue.findIndex((j) => j.urgent);
  const job = state.queue.splice(i >= 0 ? i : 0, 1)[0];
  state.pending.set(job.id, job);
  state.worker.postMessage({ id: job.id, text: job.text, voice: job.voice, speed: job.speed });
}

/** Синтезирует текст. urgent — запрос из интерфейса, идёт раньше фоновой озвучки. */
export function synth(text, { voice, speed, urgent = false } = {}) {
  const s = getSettings();
  ensureWorker();
  return new Promise((resolve, reject) => {
    state.queue.push({ id: ++state.seq, text, voice: voice || s.ttsVoice, speed: Number(speed || s.ttsSpeed) || 1, urgent, resolve, reject });
    dispatch();
  });
}

const audioKey = (s = getSettings()) => `${s.ttsVoice}|${Number(s.ttsSpeed) || 1}`;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

// ---- Предложения книги ----------------------------------------------------------

const sentenceRow = db.prepare(`SELECT s.id, s.book_id, s.text, s.audio, c.idx AS chapter FROM sentences s JOIN chapters c ON c.id = s.chapter_id WHERE s.id = ?`);
const setAudio = db.prepare('UPDATE sentences SET audio = ?, audio_key = ?, audio_error = NULL WHERE id = ?');
const inflightSentences = new Map(); // id -> Promise

/** Путь к файлу озвучки предложения; если файла нет — генерирует (urgent для интерфейса). */
export async function sentenceAudio(id, { urgent = true } = {}) {
  const row = sentenceRow.get(id);
  if (!row) return null;
  if (row.audio) {
    const file = path.join(AUDIO_DIR, row.audio);
    if (fs.existsSync(file)) return file;
  }
  if (!inflightSentences.has(id)) {
    const p = (async () => {
      const key = audioKey();
      const r = await synth(row.text, { urgent });
      const rel = path.join(String(row.book_id), `${id}.${r.ext}`);
      fs.mkdirSync(path.join(AUDIO_DIR, String(row.book_id)), { recursive: true });
      fs.writeFileSync(path.join(AUDIO_DIR, rel), r.data);
      setAudio.run(rel, key, id);
      emit('audio', { bookId: row.book_id, chapter: row.chapter, id });
      return path.join(AUDIO_DIR, rel);
    })().finally(() => inflightSentences.delete(id));
    inflightSentences.set(id, p);
  } else if (urgent) {
    // Уже генерируется в фоне — поднимаем приоритет, если задача ещё в очереди.
    for (const j of state.queue) if (j.text === row.text) j.urgent = true;
  }
  return inflightSentences.get(id);
}

// ---- Слова и фразы на лету (кэш) -------------------------------------------------

const cacheGet = db.prepare('SELECT file FROM audio_cache WHERE key = ?');
const cachePut = db.prepare('INSERT OR REPLACE INTO audio_cache (key, file, at) VALUES (?, ?, ?)');

export async function textAudio(text, { voice, speed } = {}) {
  const s = getSettings();
  const v = voice || s.ttsVoice;
  const sp = Number(speed || s.ttsSpeed) || 1;
  const key = hash(`${v}|${sp}|${text}`);
  const hit = cacheGet.get(key);
  if (hit && fs.existsSync(path.join(CACHE_DIR, hit.file))) return path.join(CACHE_DIR, hit.file);
  const r = await synth(text, { voice: v, speed: sp, urgent: true });
  const file = `${key}.${r.ext}`;
  fs.writeFileSync(path.join(CACHE_DIR, file), r.data);
  cachePut.run(key, file, Date.now());
  return path.join(CACHE_DIR, file);
}

// ---- Фоновая озвучка ------------------------------------------------------------
// После перевода главы её предложения озвучиваются по порядку чтения: текущая глава первой.

const nextForBackground = db.prepare(`
  SELECT s.id FROM sentences s
  JOIN chapters c ON c.id = s.chapter_id
  JOIN books b ON b.id = s.book_id
  WHERE s.audio IS NULL AND s.audio_error IS NULL
    AND NOT EXISTS (SELECT 1 FROM sentences p WHERE p.chapter_id = c.id AND p.status != 'done')
  ORDER BY COALESCE(b.opened_at, b.added_at) DESC, (c.idx < b.pos_chapter), c.idx, s.idx
  LIMIT 1`);
const markAudioError = db.prepare('UPDATE sentences SET audio_error = ? WHERE id = ?');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backgroundLoop() {
  if (state.background) return;
  state.background = true;
  try {
    for (;;) {
      const s = getSettings();
      if (!s.ttsEnabled || s.ttsPaused) break;
      // Перевод через Ollama и озвучка вместе загрузят все ядра — фоновая озвучка ждёт.
      if (cpuHeavyTranslation()) { await sleep(5000); continue; }
      const next = nextForBackground.get();
      if (!next) break;
      try {
        await sentenceAudio(next.id, { urgent: false });
      } catch (e) {
        markAudioError.run(String(e.message || e).slice(0, 300), next.id);
        if (state.status === 'error') break;
      }
    }
  } finally {
    state.background = false;
  }
}

/** Будит фоновую озвучку (после перевода главы, смены настроек, при старте). */
export function kickTts() {
  const s = getSettings();
  if (!s.ttsEnabled || s.ttsPaused) return;
  if (!nextForBackground.get()) return;
  ensureWorker();
  if (state.status === 'ready') backgroundLoop();
}

export function ttsStatus() {
  const total = state.stats.reduce((a, x) => a + x.duration, 0);
  const gen = state.stats.reduce((a, x) => a + x.genMs, 0) / 1000;
  const left = db.prepare(`SELECT COUNT(*) AS n FROM sentences WHERE audio IS NULL AND audio_error IS NULL`).get().n;
  return {
    status: state.status,
    error: state.error,
    encoder: FFMPEG ? 'opus (ffmpeg)' : 'mp3 (lamejs)',
    voices: state.voices,
    speedX: gen > 0 ? Math.round((total / gen) * 100) / 100 : null, // во сколько раз быстрее реального времени
    queue: state.queue.length + state.pending.size,
    background: state.background,
    left,
    paused: !!getSettings().ttsPaused,
  };
}

/** Удаляет озвучку (например, после смены голоса), чтобы фон сгенерировал её заново. */
export function resetAudio(bookId = null) {
  const rows = bookId
    ? db.prepare('SELECT audio FROM sentences WHERE book_id = ? AND audio IS NOT NULL').all(bookId)
    : db.prepare('SELECT audio FROM sentences WHERE audio IS NOT NULL').all();
  for (const r of rows) fs.rmSync(path.join(AUDIO_DIR, r.audio), { force: true });
  if (bookId) db.prepare('UPDATE sentences SET audio = NULL, audio_key = NULL, audio_error = NULL WHERE book_id = ?').run(bookId);
  else db.prepare('UPDATE sentences SET audio = NULL, audio_key = NULL, audio_error = NULL').run();
  emit('audio', { bookId });
  kickTts();
}

export function stopTts() {
  state.worker?.terminate();
}
