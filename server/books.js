// Запросы к книгам, главам и предложениям.

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { BOOKS_DIR, AUDIO_DIR } from './config.js';

const stats = db.prepare(`
  SELECT book_id,
    COUNT(*) AS total,
    SUM(status = 'done') AS translated,
    SUM(status = 'error') AS errors,
    SUM(audio IS NOT NULL) AS voiced
  FROM sentences WHERE book_id = ? GROUP BY book_id`);

const chapterStats = db.prepare(`
  SELECT c.idx, c.title, c.level, c.n_sentences AS total,
    (SELECT COUNT(*) FROM sentences s WHERE s.chapter_id = c.id AND s.status = 'done') AS translated,
    (SELECT COUNT(*) FROM sentences s WHERE s.chapter_id = c.id AND s.status = 'error') AS errors,
    (SELECT COUNT(*) FROM sentences s WHERE s.chapter_id = c.id AND s.audio IS NOT NULL) AS voiced
  FROM chapters c WHERE c.book_id = ? ORDER BY c.idx`);

const sentencesBefore = db.prepare(`
  SELECT COALESCE(SUM(n_sentences), 0) AS n FROM chapters WHERE book_id = ? AND idx < ?`);

function bookRow(b) {
  const s = stats.get(b.id) || { total: 0, translated: 0, errors: 0, voiced: 0 };
  const before = sentencesBefore.get(b.id, b.pos_chapter).n + b.pos_sentence;
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    lang: b.lang,
    targetLang: b.target_lang,
    format: b.format,
    hasCover: !!b.cover,
    addedAt: b.added_at,
    openedAt: b.opened_at,
    paused: !!b.paused,
    position: { chapter: b.pos_chapter, sentence: b.pos_sentence },
    total: s.total || 0,
    translated: s.translated || 0,
    errors: s.errors || 0,
    voiced: s.voiced || 0,
    readPercent: s.total ? Math.min(100, Math.round((before / s.total) * 100)) : 0,
  };
}

export function listBooks() {
  return db.prepare('SELECT * FROM books ORDER BY COALESCE(opened_at, added_at) DESC').all().map(bookRow);
}

export function getBookRow(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

export function getBook(id) {
  const b = getBookRow(id);
  if (!b) return null;
  return { ...bookRow(b), chapters: chapterStats.all(id) };
}

export function coverPath(id) {
  const b = getBookRow(id);
  return b?.cover ? path.join(BOOKS_DIR, String(id), b.cover) : null;
}

export function deleteBook(id) {
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  fs.rmSync(path.join(BOOKS_DIR, String(id)), { recursive: true, force: true });
  fs.rmSync(path.join(AUDIO_DIR, String(id)), { recursive: true, force: true });
}

const chapterByIdx = db.prepare('SELECT * FROM chapters WHERE book_id = ? AND idx = ?');
const chapterSentences = db.prepare(`
  SELECT id, idx, para, kind, text, status, gloss, error, audio
  FROM sentences WHERE chapter_id = ? ORDER BY idx`);

export function getChapter(bookId, idx) {
  const c = chapterByIdx.get(bookId, idx);
  if (!c) return null;
  const sentences = chapterSentences.all(c.id).map((s) => ({
    id: s.id,
    idx: s.idx,
    para: s.para,
    kind: s.kind,
    text: s.text,
    status: s.status,
    gloss: s.gloss ? JSON.parse(s.gloss) : null,
    error: s.error || null,
    audio: !!s.audio,
  }));
  return { idx: c.idx, title: c.title, total: c.n_sentences, sentences };
}

export function setPosition(bookId, chapter, sentence) {
  db.prepare('UPDATE books SET pos_chapter = ?, pos_sentence = ?, opened_at = ? WHERE id = ?')
    .run(chapter, sentence, new Date().toISOString(), bookId);
}

// ---- Закладки ----------------------------------------------------------------

export function listBookmarks(bookId) {
  return db.prepare(`
    SELECT b.id, b.chapter_idx AS chapter, b.sentence_idx AS sentence, b.note, b.created_at AS createdAt,
      c.title AS chapterTitle,
      (SELECT text FROM sentences s WHERE s.chapter_id = c.id AND s.idx = b.sentence_idx) AS text
    FROM bookmarks b LEFT JOIN chapters c ON c.book_id = b.book_id AND c.idx = b.chapter_idx
    WHERE b.book_id = ? ORDER BY b.chapter_idx, b.sentence_idx`).all(bookId);
}

export function addBookmark(bookId, chapter, sentence, note = '') {
  const exists = db.prepare('SELECT id FROM bookmarks WHERE book_id = ? AND chapter_idx = ? AND sentence_idx = ?').get(bookId, chapter, sentence);
  if (exists) return exists.id;
  return Number(db.prepare('INSERT INTO bookmarks (book_id, chapter_idx, sentence_idx, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, chapter, sentence, note, new Date().toISOString()).lastInsertRowid);
}

export function deleteBookmark(bookId, id) {
  db.prepare('DELETE FROM bookmarks WHERE book_id = ? AND id = ?').run(bookId, id);
}
