// Локальный сервер: API, SSE и собранный фронтенд. Слушает только 127.0.0.1.

import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import { HOST, PORT, DIST_DIR, DATA_DIR } from './config.js';
import { db, getSettings, updateSettings } from './db.js';
import { importBook } from './importers/index.js';
import {
  listBooks, getBook, getBookRow, coverPath, deleteBook, getChapter, setPosition,
  listBookmarks, addBookmark, deleteBookmark,
} from './books.js';
import { bus, emit } from './events.js';
import { pump, pauseAll, resumeAll, queueStatus, retrySentence, retryBookErrors, retranslateChapter } from './queue/translate.js';
import { killAllClaude } from './providers/claude-code.js';
import { saveItem, findItem, keyFor, listItems, deleteItem, deleteExample, savedKeys, answer, exportJson, getItem } from './vocab.js';
import { translateSelection, storeSelection } from './selection.js';

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
  return item;
});

// ---- Перевод выделения -------------------------------------------------------

app.post('/api/selection', async (req, reply) => {
  try {
    return await translateSelection(req.body || {});
  } catch (e) {
    return reply.code(502).send({ error: e.message });
  }
});
app.post('/api/selection/cache', async (req) => { storeSelection(req.body || {}); return { ok: true }; });

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
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
  });
} else {
  app.get('/', async () => 'Фронтенд не собран: выполните npm run build (или npm start).');
}

await app.listen({ host: HOST, port: PORT });
console.log(`Book reader: http://${HOST}:${PORT}  (данные: ${DATA_DIR})`);

const shutdown = async () => { killAllClaude(); await app.close().catch(() => {}); process.exit(0); };
process.on('exit', killAllClaude);
pump();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
