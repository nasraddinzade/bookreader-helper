// Игра: очки за чтение вслух, викторину и повторение; уровни, звания и серия дней.

import { db, today } from './db.js';
import { levelInfo } from '../shared/read-align.js';
import { getBookRow } from './books.js';
import { mergeSplitUnits } from './gloss.js';
import { fillBases } from './queue/dictionary.js';
import { wordRank } from './speech.js';
import { saveItem, keyFor } from './vocab.js';

const insEvent = db.prepare(`INSERT INTO game_events (at, day, kind, points, book_id, chapter_idx, para, data)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

export function recordEvent({ kind, points = 0, bookId = null, chapter = null, para = null, data = {} }) {
  insEvent.run(new Date().toISOString(), today(), kind, Math.max(0, Math.round(points)), bookId, chapter, para, JSON.stringify(data));
  return summary();
}

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Серия: сколько дней подряд (до сегодня или вчера) было хоть одно игровое событие. */
function streak(days) {
  const set = new Set(days);
  const d = new Date();
  if (!set.has(dayOf(d))) d.setDate(d.getDate() - 1); // сегодня ещё не занимались — серия держится со вчера
  let n = 0;
  while (set.has(dayOf(d))) { n++; d.setDate(d.getDate() - 1); }
  return { days: n, today: set.has(today()) };
}

export function summary() {
  const xp = db.prepare('SELECT COALESCE(SUM(points), 0) AS xp FROM game_events').get().xp;
  const t = db.prepare(`SELECT COALESCE(SUM(points), 0) AS points,
      SUM(kind = 'read') AS paragraphs, SUM(kind = 'quiz') AS quiz, SUM(kind = 'review') AS review
    FROM game_events WHERE day = ?`).get(today());
  const days = db.prepare('SELECT DISTINCT day FROM game_events ORDER BY day DESC LIMIT 400').all().map((r) => r.day);
  const reads = db.prepare(`SELECT data FROM game_events WHERE kind = 'read'`).all().map((r) => JSON.parse(r.data));
  return {
    ...levelInfo(xp),
    today: { points: t.points || 0, paragraphs: t.paragraphs || 0, quiz: t.quiz || 0, review: t.review || 0 },
    streak: streak(days),
    totals: {
      paragraphs: reads.length,
      perfect: reads.filter((r) => r.stars === 3).length,
      bestCombo: reads.reduce((m, r) => Math.max(m, r.maxCombo || 0), 0),
      known: db.prepare('SELECT COUNT(*) AS n FROM game_known').get().n,
    },
  };
}

// ---- Викторина по словам абзаца -------------------------------------------------

const CONTENT = /^(noun|verb|adj|adv|phrasal verb|idiom)$/;
const cleanCtx = (s) => String(s || '').trim().replace(/^[«»"“”„‘’'.,;:!?…()\s]+|[«»"“”„‘’'.,;:!?…()\s]+$/g, '');
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const chapterRows = db.prepare(`SELECT s.id, s.idx, s.para, s.text, s.gloss FROM sentences s JOIN chapters c ON c.id = s.chapter_id
  WHERE c.book_id = ? AND c.idx = ? AND s.status = 'done' ORDER BY s.idx`);
const isKnown = db.prepare('SELECT 1 FROM game_known WHERE lang = ? AND lemma = ?');
const isLearned = db.prepare(`SELECT 1 FROM vocab WHERE kind = 'word' AND lang = ? AND key = ? AND learned = 1`);

/**
 * До 3 слов абзаца, которые игрок вероятно не знает: значимые, не имена, не выученные в словаре,
 * не угаданные раньше в викторине; сначала самые редкие по частотному списку.
 * К каждому — 4 варианта перевода: верный (перевод в этом контексте) и 3 перевода других слов главы.
 */
export function quiz({ bookId, chapter, para, n = 3 }) {
  const book = getBookRow(bookId);
  if (!book) return [];
  const rows = chapterRows.all(bookId, chapter).map((r) => {
    const gloss = JSON.parse(r.gloss);
    const tokens = fillBases(book.lang, book.target_lang, mergeSplitUnits(gloss.tokens));
    return { ...r, full: gloss.full, tokens };
  });
  const all = rows.flatMap((r) => r.tokens.map((t, k) => ({ ...t, ctx: cleanCtx(t.ctx), row: r, k })))
    .filter((t) => t.ctx && t.ctx !== '–' && /\p{L}/u.test(t.en));
  const seen = new Set();
  const candidates = all
    .filter((t) => t.row.para === para && CONTENT.test(t.pos) && t.pos !== 'name')
    .map((t) => ({ ...t, lemmaKey: (t.lemma || t.en).toLowerCase().replace(/[^\p{L}' -]/gu, '').trim() }))
    .filter((t) => t.lemmaKey.length >= 3)
    .filter((t) => !isKnown.get(book.lang, t.lemmaKey) && !isLearned.get(book.lang, keyFor('word', { lemma: t.lemmaKey })))
    .map((t) => {
      const r = t.lemmaKey.split(' ').map((w) => wordRank(w) ?? 40000);
      return { ...t, rank: Math.max(...r) + (r.length > 1 ? 3000 : 0) }; // выражения из нескольких слов — тоже интересные
    })
    .filter((t) => t.rank >= 1500) // самые частые слова почти наверняка знакомы
    .sort((a, b) => b.rank - a.rank)
    .filter((t) => (seen.has(t.lemmaKey) ? false : seen.add(t.lemmaKey)))
    .slice(0, n);

  return candidates.map((t) => {
    const others = shuffle(all.filter((o) => o.lemma?.toLowerCase() !== t.lemma?.toLowerCase() && o.ctx.toLowerCase() !== t.ctx.toLowerCase()));
    const samePos = others.filter((o) => o.pos === t.pos);
    const distract = [];
    for (const o of [...samePos, ...others]) {
      if (distract.length >= 3) break;
      if (!distract.some((d) => d.toLowerCase() === o.ctx.toLowerCase())) distract.push(o.ctx);
    }
    return {
      word: t.en.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''),
      lemma: t.lemmaKey,
      pos: t.pos,
      base: t.base || '',
      correct: t.ctx,
      options: shuffle([t.ctx, ...distract]),
      sentence: t.row.text,
      sentenceRu: t.row.full || '',
      sentenceId: t.row.id,
      sentenceIdx: t.row.idx,
      token: { en: t.en, ctx: t.ctx, lemma: t.lemma, base: t.base, pos: t.pos },
    };
  });
}

const addKnown = db.prepare('INSERT OR IGNORE INTO game_known (lang, lemma, at) VALUES (?, ?, ?)');

/**
 * Ответ викторины. С первой попытки — 20 очков и слово считается знакомым (больше не спрашивается);
 * со второй — 5 очков; не угадано — слово сохраняется в «Слова», чтобы попасть в повторение.
 */
export function quizAnswer({ bookId, chapter, para, item, result }) {
  const book = getBookRow(bookId);
  const lang = book?.lang || 'en';
  let points = 0;
  let saved = null;
  if (result === 'first') { points = 20; addKnown.run(lang, item.lemma, new Date().toISOString()); }
  else if (result === 'second') points = 5;
  if (result !== 'first' && book) {
    const chapterRow = db.prepare('SELECT title FROM chapters WHERE book_id = ? AND idx = ?').get(bookId, chapter);
    saved = saveItem({
      kind: 'word', lang, tgt: book.target_lang, text: item.token.en, lemma: item.token.lemma || item.lemma,
      ctx: item.token.ctx, base: item.token.base, pos: item.token.pos,
      example: {
        en: item.token.en, ctx: item.token.ctx, sentence: item.sentence, sentenceRu: item.sentenceRu,
        bookId, bookTitle: book.title, chapter, chapterTitle: chapterRow?.title || '', sentenceIdx: item.sentenceIdx,
      },
    }).item;
  }
  return { summary: recordEvent({ kind: 'quiz', points, bookId, chapter, para, data: { lemma: item.lemma, result } }), points, saved: !!saved };
}

/** Абзацы главы, уже прочитанные вслух (для отметок и порядка прохождения). */
export function readParagraphs(bookId, chapter) {
  return db.prepare(`SELECT DISTINCT para FROM game_events WHERE kind = 'read' AND book_id = ? AND chapter_idx = ? AND para IS NOT NULL ORDER BY para`)
    .all(bookId, chapter).map((r) => r.para);
}
