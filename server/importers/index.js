// Импорт книги: формат по расширению/сигнатуре, разбор, предложения через segment.js, запись в базу.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, getSettings } from '../db.js';
import { BOOKS_DIR } from '../config.js';
import { splitIntoSentences } from '../../shared/segment.js';
import { parseEpub } from './epub.js';
import { parseFb2 } from './fb2.js';
import { parseTxt } from './txt.js';

export const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function detectFormat(fileName, buf) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.epub') return 'epub';
  if (ext === '.fb2' || /\.fb2\.zip$/i.test(fileName)) return 'fb2';
  if (ext === '.txt') return 'txt';
  const head = buf.subarray(0, 400).toString('latin1');
  if (buf[0] === 0x50 && buf[1] === 0x4b) return head.includes('epub') ? 'epub' : 'fb2';
  if (/<FictionBook/i.test(head)) return 'fb2';
  return 'txt';
}

export async function parseBook(fileName, buf) {
  const format = detectFormat(fileName, buf);
  const parsed = format === 'epub' ? await parseEpub(buf) : format === 'fb2' ? await parseFb2(buf) : parseTxt(buf, fileName);
  if (!parsed.chapters.length) throw new Error('В книге не найден текст');
  return { format, ...parsed };
}

const insBook = db.prepare(`INSERT INTO books (title, author, lang, target_lang, format, file_name, added_at)
  VALUES (@title, @author, @lang, @target_lang, @format, @file_name, @added_at)`);
const insChapter = db.prepare('INSERT INTO chapters (book_id, idx, title, level, n_sentences) VALUES (?, ?, ?, ?, ?)');
const insSentence = db.prepare(`INSERT INTO sentences (book_id, chapter_id, idx, para, kind, text, hash)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

/** Разбирает и сохраняет книгу. Возвращает id книги. */
export async function importBook(fileName, buf, { targetLang } = {}) {
  const book = await parseBook(fileName, buf);
  const lang = book.lang || 'en';
  const tgt = targetLang || getSettings().targetLang || 'ru';
  const id = db.transaction(() => {
    const bookId = Number(insBook.run({
      title: book.title, author: book.author || '', lang, target_lang: tgt, format: book.format,
      file_name: 'original' + (book.format === 'fb2' && /\.zip$/i.test(fileName) ? '.fb2.zip' : '.' + book.format),
      added_at: new Date().toISOString(),
    }).lastInsertRowid);
    let ci = 0;
    for (const ch of book.chapters) {
      const rows = [];
      ch.blocks.forEach((b, para) => {
        for (const s of splitIntoSentences(b.text, lang).sentences) rows.push({ para, kind: b.kind, text: s });
      });
      if (!rows.length) continue;
      const chapterId = Number(insChapter.run(bookId, ci++, ch.title.slice(0, 300), ch.level || 0, rows.length).lastInsertRowid);
      rows.forEach((r, i) => insSentence.run(bookId, chapterId, i, r.para, r.kind, r.text, sha(r.text)));
    }
    return bookId;
  })();

  const dir = path.join(BOOKS_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const fileNameStored = db.prepare('SELECT file_name FROM books WHERE id = ?').get(id).file_name;
  fs.writeFileSync(path.join(dir, fileNameStored), buf);
  if (book.cover?.data?.length) {
    const coverName = 'cover' + book.cover.ext;
    fs.writeFileSync(path.join(dir, coverName), book.cover.data);
    db.prepare('UPDATE books SET cover = ? WHERE id = ?').run(coverName, id);
  }
  return id;
}
