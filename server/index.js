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
  const s = updateSettings(req.body || {});
  emit('settings', {});
  return s;
});

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
  await app.register(fastifyStatic, { root: DIST_DIR, prefix: '/' });
} else {
  app.get('/', async () => 'Фронтенд не собран: выполните npm run build (или npm start).');
}

await app.listen({ host: HOST, port: PORT });
console.log(`Book reader: http://${HOST}:${PORT}  (данные: ${DATA_DIR})`);

const shutdown = async () => { await app.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
