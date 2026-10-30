// Локальный сервер: API, SSE и собранный фронтенд. Слушает только 127.0.0.1.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { HOST, PORT, DIST_DIR, DATA_DIR, MODELS_DIR } from './config.js';
import { db, getSettings, updateSettings } from './db.js';
import { importBook } from './importers/index.js';
import {
  listBooks, getBook, getBookRow, coverPath, deleteBook, getChapter, setPosition,
  listBookmarks, addBookmark, deleteBookmark,
} from './books.js';
import { bus, emit } from './events.js';
import { pump, pauseAll, resumeAll, queueStatus, retrySentence, retryBookErrors, retranslateChapter, cacheGlosses } from './queue/translate.js';
import { ensureOllama, ollamaInfo, pullModel, benchmark, stopOllama } from './ollama-manager.js';
import { ollamaProvider } from './providers/ollama-gloss.js';
import { killAllClaude } from './providers/claude-code.js';
import { saveItem, findItem, keyFor, listItems, deleteItem, deleteExample, savedKeys, answer, exportJson, getItem } from './vocab.js';
import { translateSelection, storeSelection } from './selection.js';
import { wordMeanings } from './queue/dictionary.js';
import { speechWords, commonWords } from './speech.js';
import { recordEvent, summary as gameSummary, quiz, quizAnswer, readParagraphs } from './game.js';
import { sentenceAudio, textAudio, ttsStatus, kickTts, resetAudio, stopTts, synth } from './tts/index.js';

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 10 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 1 } });

const num = (v) => Number.parseInt(v, 10);
const notFound = (reply, what = 'Не найдено') => reply.code(404).send({ error: what });

// ---- Книги -------------------------------------------------------------------

app.get('/api/books', async () => listBooks());

app.post('/api/books', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'Файл не передан' });
  const buf = await file.toBuffer();
  try {
    const id = await importBook(file.filename, buf);
    emit('library', {});
    pump();
    return { id };
  } catch (e) {
    req.log.warn(e);
    return reply.code(400).send({ error: 'Не удалось импортировать книгу: ' + e.message });
  }
});

app.get('/api/books/:id', async (req, reply) => getBook(num(req.params.id)) || notFound(reply, 'Книга не найдена'));

app.delete('/api/books/:id', async (req) => {
  deleteBook(num(req.params.id));
  emit('library', {});
  return { ok: true };
});

app.get('/api/books/:id/cover', async (req, reply) => {
  const p = coverPath(num(req.params.id));
  if (!p || !fs.existsSync(p)) return notFound(reply);
  reply.header('Cache-Control', 'max-age=86400');
  return reply.type(p.endsWith('.png') ? 'image/png' : 'image/jpeg').send(fs.createReadStream(p));
});

app.get('/api/books/:id/chapters/:idx', async (req, reply) =>
  getChapter(num(req.params.id), num(req.params.idx)) || notFound(reply, 'Глава не найдена'));

app.put('/api/books/:id/position', async (req, reply) => {
  const id = num(req.params.id);
  if (!getBookRow(id)) return notFound(reply);
  const { chapter = 0, sentence = 0 } = req.body || {};
  setPosition(id, num(chapter), num(sentence));
  emit('position', { bookId: id, chapter: num(chapter) });
  pump();
  return { ok: true };
});

app.post('/api/books/:id/pause', async (req) => {
  db.prepare('UPDATE books SET paused = 1 WHERE id = ?').run(num(req.params.id));
  emit('queue', { bookId: num(req.params.id) });
  return { ok: true };
});
app.post('/api/books/:id/resume', async (req) => {
  db.prepare('UPDATE books SET paused = 0 WHERE id = ?').run(num(req.params.id));
  emit('queue', { bookId: num(req.params.id) });
  pump();
  return { ok: true };
});

app.get('/api/books/:id/bookmarks', async (req) => listBookmarks(num(req.params.id)));
app.post('/api/books/:id/bookmarks', async (req) => {
  const { chapter, sentence, note } = req.body || {};
  return { id: addBookmark(num(req.params.id), num(chapter), num(sentence), note || '') };
});
app.delete('/api/books/:id/bookmarks/:bid', async (req) => {
  deleteBookmark(num(req.params.id), num(req.params.bid));
  return { ok: true };
});

// ---- Настройки ---------------------------------------------------------------

app.get('/api/settings', async () => getSettings());
app.put('/api/settings', async (req) => {
  const before = getSettings().provider;
  const s = updateSettings(req.body || {});
  // Заглушка не переводит: при переходе на настоящий провайдер её «переводы» снова в очередь.
  if (before === 'stub' && s.provider !== 'stub') {
    db.prepare(`UPDATE sentences SET status = 'pending', gloss = NULL, attempts = 0 WHERE translated_by = 'stub'`).run();
  }
  emit('settings', {});
  pump();
  return s;
});

// ---- Очередь перевода --------------------------------------------------------

app.get('/api/queue', async () => queueStatus());
app.post('/api/queue/pause', async () => { pauseAll(); return queueStatus(); });
app.post('/api/queue/resume', async () => { resumeAll(); return queueStatus(); });
app.post('/api/sentences/:id/retry', async (req) => { retrySentence(num(req.params.id)); return { ok: true }; });
app.post('/api/books/:id/retry-errors', async (req) => { retryBookErrors(num(req.params.id)); return { ok: true }; });
app.post('/api/books/:id/chapters/:idx/retranslate', async (req) => {
  retranslateChapter(num(req.params.id), num(req.params.idx));
  return { ok: true };
});

// ---- Словарь: слова и фразы -------------------------------------------------

app.get('/api/vocab', async (req) => listItems(req.query.kind));
app.get('/api/vocab/keys', async (req) => savedKeys(req.query.lang || 'en'));
app.get('/api/vocab/lookup', async (req) => {
  const { kind = 'word', lang = 'en', text = '', lemma = '' } = req.query;
  return findItem(kind, lang, keyFor(kind, { text, lemma })) || null;
});
app.get('/api/vocab/export', async (req, reply) => {
  const kind = req.query.kind || '';
  const day = new Date().toISOString().slice(0, 10);
  reply.header('Content-Disposition', `attachment; filename="${kind || 'vocab'}-${day}.json"`);
  return exportJson(kind || undefined);
});
app.post('/api/vocab', async (req, reply) => {
  try {
    const r = saveItem(req.body || {});
    emit('vocab', {});
    return r;
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
});
app.get('/api/vocab/:id', async (req, reply) => getItem(num(req.params.id)) || notFound(reply));
app.delete('/api/vocab/:id', async (req) => { deleteItem(num(req.params.id)); emit('vocab', {}); return { ok: true }; });
app.delete('/api/vocab/:id/examples/:eid', async (req) => {
  deleteExample(num(req.params.id), num(req.params.eid));
  emit('vocab', {});
  return { ok: true };
});
app.post('/api/vocab/:id/answer', async (req) => {
  const item = answer(num(req.params.id), !!req.body?.knew);
  emit('vocab', {});
  // Верный ответ в повторении тоже приносит немного опыта и засчитывает день в серию.
  if (req.body?.knew) { recordEvent({ kind: 'review', points: 3, data: { id: num(req.params.id) } }); emit('game', {}); }
  return item;
});

// ---- Игра: чтение вслух, викторина, уровни -----------------------------------

app.get('/api/game', async () => gameSummary());
app.get('/api/game/paras', async (req) => readParagraphs(num(req.query.bookId), num(req.query.chapter)));
app.post('/api/game/read', async (req) => {
  const { bookId, chapter, para, stats } = req.body || {};
  const s = recordEvent({ kind: 'read', points: Math.min(3000, Number(stats?.points) || 0), bookId, chapter, para, data: stats || {} });
  emit('game', {});
  return s;
});
app.post('/api/game/quiz', async (req) => quiz(req.body || {}));
app.post('/api/game/quiz/answer', async (req) => {
  const r = quizAnswer(req.body || {});
  emit('game', {});
  if (r.saved) emit('vocab', {});
  return r;
});

// Значения отдельных слов многословного блока (для карточки слова).
app.get('/api/dict/words', async (req) => wordMeanings(req.query.lang || 'en', req.query.tgt || 'ru', String(req.query.text || '').slice(0, 200)));

// ---- Перевод выделения -------------------------------------------------------

app.post('/api/selection', async (req, reply) => {
  try {
    return await translateSelection(req.body || {});
  } catch (e) {
    return reply.code(502).send({ error: e.message });
  }
});
app.post('/api/selection/cache', async (req) => { storeSelection(req.body || {}); return { ok: true }; });

// ---- Озвучка ----------------------------------------------------------------

const sendAudio = (reply, file) => {
  reply.header('Cache-Control', 'no-cache');
  return reply.type(file.endsWith('.ogg') ? 'audio/ogg' : 'audio/mpeg').send(fs.createReadStream(file));
};

app.get('/api/audio/:sid', async (req, reply) => {
  try {
    const file = await sentenceAudio(num(req.params.sid));
    return file ? sendAudio(reply, file) : notFound(reply);
  } catch (e) {
    return reply.code(503).send({ error: 'Озвучка недоступна: ' + e.message });
  }
});
app.get('/api/tts', async (req, reply) => {
  const text = String(req.query.text || '').slice(0, 600).trim();
  if (!text) return reply.code(400).send({ error: 'Пустой текст' });
  try {
    return sendAudio(reply, await textAudio(text));
  } catch (e) {
    return reply.code(503).send({ error: 'Озвучка недоступна: ' + e.message });
  }
});
app.get('/api/tts/status', async () => ttsStatus());
app.post('/api/tts/sample', async (req, reply) => {
  const { voice, speed, text } = req.body || {};
  try {
    const r = await synth(text || 'Alice was beginning to get very tired of sitting by her sister on the bank.', { voice, speed, urgent: true });
    reply.header('Cache-Control', 'no-store');
    return reply.type(r.ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg').send(r.data);
  } catch (e) {
    return reply.code(503).send({ error: e.message });
  }
});
app.post('/api/tts/reset', async (req) => { resetAudio(req.body?.bookId ? num(req.body.bookId) : null); return { ok: true }; });

// ---- Ollama -------------------------------------------------------------------

app.get('/api/ollama', async () => ollamaInfo());
app.post('/api/ollama/start', async (req, reply) => {
  try { await ensureOllama(); return ollamaInfo(); } catch (e) { return reply.code(503).send({ error: e.message }); }
});
app.post('/api/ollama/pull', async (req, reply) => {
  try { await pullModel(req.body?.model || getSettings().ollamaModel); return { ok: true }; } catch (e) { return reply.code(400).send({ error: e.message }); }
});
// Замер на 5 предложениях книги (или примерах) и оценка времени на всю книгу.
// Переводы из замера попадают в кэш — очередь их не запрашивает повторно.
app.post('/api/ollama/benchmark', async (req, reply) => {
  const s = getSettings();
  const model = req.body?.model || s.ollamaModel;
  const bookId = req.body?.bookId ? num(req.body.bookId) : null;
  const book = bookId ? getBookRow(bookId) : null;
  const items = book
    ? db.prepare(`SELECT s.id, s.text, s.hash FROM sentences s JOIN chapters c ON c.id = s.chapter_id
        WHERE s.book_id = ? AND s.status = 'pending' AND length(s.text) > 40 ORDER BY (c.idx < ?), c.idx, s.idx LIMIT 5`).all(bookId, book.pos_chapter)
    : [
      'Alice was beginning to get very tired of sitting by her sister on the bank.',
      'She found out that the rabbit had gone back to its hole.',
      '“I shall be late!” said the Rabbit, and hurried off.',
      'It was kind of strange, but she decided to get back to her reading.',
      'There was nothing so very remarkable in that, and she went on.',
    ].map((text, i) => ({ id: -i, text, hash: '' }));
  if (!items.length) return reply.code(400).send({ error: 'В книге нет непереведённых предложений для замера' });
  const provider = { cacheable: true, ...ollamaProvider({ model, threads: s.ollamaThreads, src: book?.lang || 'en', tgt: book?.target_lang || 'ru' }) };
  try {
    const t0 = Date.now();
    const bench = await benchmark(provider, items.map((i) => i.text), Number(s.ollamaThreads) || 6);
    let cached = 0;
    if (book) cached = cacheGlosses(book, provider, items, bench.all);
    const pending = book ? db.prepare("SELECT COUNT(*) AS n FROM sentences WHERE book_id = ? AND status = 'pending'").get(bookId).n : null;
    const { all, ...rest } = bench;
    return { ...rest, cached, pending, etaMin: pending ? Math.round((pending * bench.secPerSentence) / 60) : null, wallMs: Date.now() - t0 };
  } catch (e) {
    return reply.code(503).send({ error: e.message });
  }
});

// ---- Модель распознавания речи (Vosk, работает в браузере) -----------------

app.get('/api/models/vosk/:file', async (req, reply) => {
  const name = String(req.params.file);
  if (!/^[\w.-]+\.tar\.gz$/.test(name)) return notFound(reply);
  const file = path.join(MODELS_DIR, 'vosk', name);
  if (!fs.existsSync(file)) return notFound(reply, 'Модель распознавания не скачана');
  reply.header('Cache-Control', 'max-age=604800');
  return reply.type('application/gzip').send(fs.createReadStream(file));
});

app.get('/api/speech/common', async (req) => commonWords(Math.min(10000, Number(req.query.n) || 3000)));
app.post('/api/speech/words', async (req) => speechWords((req.body?.words || []).slice(0, 2000)));

// ---- События (SSE) -----------------------------------------------------------

app.get('/api/events', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  reply.raw.write('retry: 2000\n\n');
  const send = (ev) => reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 20000);
  bus.on('event', send);
  req.raw.on('close', () => { clearInterval(ping); bus.off('event', send); });
});

// ---- Фронтенд ----------------------------------------------------------------

if (fs.existsSync(DIST_DIR)) {
  await app.register(fastifyStatic, {
    root: DIST_DIR,
    prefix: '/',
    // index.html не кэшируем: после пересборки он ссылается на новые файлы с хэшами.
    setHeaders: (res, file) => {
      if (!file.endsWith('.html')) return;
      if (typeof res.setHeader === 'function') res.setHeader('Cache-Control', 'no-cache');
      else res.header?.('Cache-Control', 'no-cache');
    },
  });
} else {
  app.get('/', async () => 'Фронтенд не собран: выполните npm run build (или npm start).');
}

await app.listen({ host: HOST, port: PORT });
console.log(`Book reader: http://${HOST}:${PORT}  (данные: ${DATA_DIR})`);
// --open: открыть читалку в браузере, когда сервер уже слушает (так запускает ярлык).
if (process.argv.includes('--open')) {
  spawn('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}/`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

bus.on('event', (ev) => { if (ev.type === 'chapter-done' || ev.type === 'settings' || ev.type === 'position') kickTts(); });
kickTts();

const shutdown = async () => { killAllClaude(); stopTts(); stopOllama(); await app.close().catch(() => {}); process.exit(0); };
process.on('exit', () => { killAllClaude(); stopOllama(); });
pump();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
