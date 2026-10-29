// Личный словарь: слова (kind = 'word') и фразы (kind = 'phrase'), примеры, повторение.
// Слово дедуплицируется по лемме, фраза — по нормализованному тексту; повтор добавляет пример.

import { db, today } from './db.js';
import { wordKey } from '../shared/wordkey.js';
import { dictBase } from './queue/dictionary.js';

export { wordKey };

export const REQUIRED_DAYS = 3;

const trimPunct = (s) => String(s || '').replace(/^[\s"“”'‘’(\[«—–-]+|[\s"“”'‘’)\]».,;:!?—–-]+$/g, '');

function rowToItem(r, examples = []) {
  return {
    id: r.id,
    kind: r.kind,
    lang: r.lang,
    tgt: r.tgt,
    key: r.key,
    text: r.text,
    lemma: r.lemma,
    ctx: r.ctx,
    base: r.base,
    pos: r.pos,
    addedAt: r.added_at,
    cleanHitDays: JSON.parse(r.clean_hit_days || '[]'),
    requiredDays: r.required_days,
    learned: !!r.learned,
    misses: r.misses,
    lastMissAt: r.last_miss_at,
    lastReviewAt: r.last_review_at,
    examples,
  };
}

const exampleRow = (e) => ({
  id: e.id,
  en: e.en,
  ctx: e.ctx,
  sentence: e.sentence,
  sentenceRu: e.sentence_ru,
  bookId: e.book_id,
  bookTitle: e.book_title,
  chapter: e.chapter_idx,
  chapterTitle: e.chapter_title,
  sentenceIdx: e.sentence_idx,
  addedAt: e.added_at,
  bookExists: e.book_exists === 1,
});

const examplesOf = db.prepare(`SELECT e.*, (SELECT 1 FROM books b WHERE b.id = e.book_id) AS book_exists
  FROM examples e WHERE vocab_id = ? ORDER BY e.added_at, e.id`);

export function keyFor(kind, { text, lemma }) {
  if (kind === 'phrase') return wordKey(text);
  return wordKey(lemma) || wordKey(text);
}

export function findItem(kind, lang, key) {
  const r = db.prepare('SELECT * FROM vocab WHERE kind = ? AND lang = ? AND key = ?').get(kind, lang, key);
  return r ? rowToItem(r, examplesOf.all(r.id).map(exampleRow)) : null;
}

export function getItem(id) {
  const r = db.prepare('SELECT * FROM vocab WHERE id = ?').get(id);
  return r ? rowToItem(r, examplesOf.all(r.id).map(exampleRow)) : null;
}

/**
 * Сохраняет слово или фразу. Если запись с тем же ключом есть, дубль не создаётся —
 * добавляется пример (если такого предложения у записи ещё нет).
 */
export function saveItem({ kind = 'word', lang = 'en', tgt = 'ru', text, lemma = '', ctx = '', base = '', pos = '', example = null }) {
  const cleanText = trimPunct(text);
  const key = keyFor(kind, { text: cleanText, lemma });
  if (!key) throw new Error('Пустое слово');
  // Быстрый режим: словарное значение могло ещё не прийти в карточку — берём из словаря лемм.
  if (!base && kind === 'word') base = dictBase(lang, tgt, lemma);
  return db.transaction(() => {
    let row = db.prepare('SELECT * FROM vocab WHERE kind = ? AND lang = ? AND key = ?').get(kind, lang, key);
    let created = false;
    if (!row) {
      const id = Number(db.prepare(`INSERT INTO vocab (kind, lang, tgt, key, text, lemma, ctx, base, pos, added_at, required_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(kind, lang, tgt, key, cleanText, lemma || '', ctx || '', base || '', pos || '', today(), REQUIRED_DAYS).lastInsertRowid);
      row = { id };
      created = true;
    }
    let exampleAdded = false;
    if (example?.sentence) {
      const r = db.prepare(`INSERT OR IGNORE INTO examples (vocab_id, en, ctx, sentence, sentence_ru, book_id, book_title, chapter_idx, chapter_title, sentence_idx, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, trimPunct(example.en || text), example.ctx || ctx || '', example.sentence, example.sentenceRu || '',
        example.bookId ?? null, example.bookTitle || '', example.chapter ?? null, example.chapterTitle || '', example.sentenceIdx ?? null,
        new Date().toISOString(),
      );
      exampleAdded = r.changes > 0;
    }
    return { item: getItem(row.id), created, exampleAdded };
  })();
}

export function listItems(kind) {
  const rows = kind
    ? db.prepare('SELECT * FROM vocab WHERE kind = ? ORDER BY added_at DESC, id DESC').all(kind)
    : db.prepare('SELECT * FROM vocab ORDER BY added_at DESC, id DESC').all();
  const allEx = db.prepare(`SELECT e.*, (SELECT 1 FROM books b WHERE b.id = e.book_id) AS book_exists FROM examples e ORDER BY e.added_at, e.id`).all();
  const byItem = new Map();
  for (const e of allEx) {
    if (!byItem.has(e.vocab_id)) byItem.set(e.vocab_id, []);
    byItem.get(e.vocab_id).push(exampleRow(e));
  }
  return rows.map((r) => rowToItem(r, byItem.get(r.id) || []));
}

export function deleteItem(id) {
  db.prepare('DELETE FROM vocab WHERE id = ?').run(id);
}

export function deleteExample(itemId, exampleId) {
  db.prepare('DELETE FROM examples WHERE vocab_id = ? AND id = ?').run(itemId, exampleId);
}

/** Ключи для подсветки в тексте: слова — леммы и формы из примеров, фразы — нормализованный текст. */
export function savedKeys(lang = 'en') {
  const words = new Set();
  const phrases = new Set();
  for (const r of db.prepare('SELECT id, kind, key, text FROM vocab WHERE lang = ?').all(lang)) {
    if (r.kind === 'phrase') { phrases.add(r.key); continue; }
    words.add(r.key);
    words.add(wordKey(r.text));
  }
  for (const e of db.prepare(`SELECT e.en FROM examples e JOIN vocab v ON v.id = e.vocab_id WHERE v.kind = 'word' AND v.lang = ?`).all(lang)) {
    words.add(wordKey(e.en));
  }
  words.delete('');
  return { words: [...words], phrases: [...phrases] };
}

/**
 * Ответ в повторении. Выучено после requiredDays верных ответов в РАЗНЫЕ дни;
 * несколько ответов за день — один; «Не знал» обнуляет серию.
 */
export function answer(id, knew) {
  const r = db.prepare('SELECT * FROM vocab WHERE id = ?').get(id);
  if (!r) return null;
  const d = today();
  let days = JSON.parse(r.clean_hit_days || '[]');
  let learned = 0;
  let misses = r.misses;
  let lastMiss = r.last_miss_at;
  if (knew) {
    if (!days.includes(d)) days = [...days, d];
    learned = days.length >= (r.required_days || REQUIRED_DAYS) ? 1 : 0;
  } else {
    days = [];
    misses += 1;
    lastMiss = d;
  }
  db.prepare('UPDATE vocab SET clean_hit_days = ?, learned = ?, misses = ?, last_miss_at = ?, last_review_at = ? WHERE id = ?')
    .run(JSON.stringify(days), learned, misses, lastMiss, d, id);
  return getItem(id);
}

export function exportJson(kind) {
  const items = listItems(kind);
  return { exportedAt: new Date().toISOString(), kind: kind || 'all', count: items.length, items };
}
