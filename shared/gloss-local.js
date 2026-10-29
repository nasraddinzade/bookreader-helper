// Локальный разбор предложения: токены, леммы, части речи и правила для служебных слов.
// Перевод слов и предложений делает внешний переводчик, а всё остальное считается здесь,
// библиотекой compromise, без запросов к сети.

import nlp from 'compromise';
import { NO_SPACES } from './languages.js';

const ARTICLES = {
  a: 'неопределённый артикль, не переводится',
  an: 'неопределённый артикль, не переводится',
  the: 'определённый артикль, не переводится',
};
const BE = { am: 'есть', is: 'есть', are: 'есть', was: 'был', were: 'были', be: 'быть', been: 'был', being: 'будучи' };
const BE_BASE = 'быть, являться, находиться';
const DO = new Set(['do', 'does', 'did']);

const TAG_TO_POS = [
  ['Particle', 'particle'],
  ['Modal', 'modal'],
  ['Auxiliary', 'aux'],
  ['Copula', 'verb'],
  ['Verb', 'verb'],
  ['Pronoun', 'pron'],
  ['Person', 'name'],
  ['Place', 'name'],
  ['Organization', 'name'],
  ['ProperNoun', 'name'],
  ['Acronym', 'noun'],
  ['Noun', 'noun'],
  ['Adjective', 'adj'],
  ['Adverb', 'adv'],
  ['Determiner', 'det'],
  ['Preposition', 'prep'],
  ['Conjunction', 'conj'],
  ['Negative', 'neg'],
  ['Value', 'num'],
  ['Date', 'date'],
  ['Expression', 'interj'],
  ['QuestionWord', 'pron'],
  ['There', 'there'],
];

function posOf(tags) {
  for (const [tag, pos] of TAG_TO_POS) if (tags.includes(tag)) return pos;
  return 'word';
}

const stripPunct = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const infinitiveMemo = new Map();
function infinitive(word) {
  if (!infinitiveMemo.has(word)) {
    let inf = word;
    try { inf = nlp(word).verbs().toInfinitive().text().toLowerCase() || word; } catch { /* оставляем как есть */ }
    infinitiveMemo.set(word, inf);
  }
  return infinitiveMemo.get(word);
}

/**
 * Разбирает предложение на токены. Для английского — через compromise: леммы, части речи,
 * фразовые глаголы и правила для служебных слов (правила только при переводе на русский).
 * Для остальных языков — слова как есть: по пробелам, а для языков без пробелов через Intl.Segmenter.
 * Возвращает [{ en, gap, word, lemma, pos, isName, rule: { ctx, base } | null, lookups: [] }].
 */
export function analyze(sentence, lang = 'en', target = 'ru') {
  if (!lang.startsWith('en')) return analyzeGeneric(sentence, lang);
  return analyzeEnglish(sentence, target === 'ru');
}

const stripPunctGeneric = (s) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

function analyzeGeneric(sentence, lang) {
  const tokens = [];
  if (NO_SPACES.has(lang) && typeof Intl !== 'undefined' && Intl.Segmenter) {
    // Языки без пробелов: слова от сегментатора, пунктуация прилипает к предыдущему слову.
    const seg = new Intl.Segmenter(lang, { granularity: 'word' });
    let prevEnd = 0;
    for (const s of seg.segment(sentence)) {
      const text = s.segment;
      if (/^\s+$/.test(text)) continue;
      if (!s.isWordLike && tokens.length) { tokens[tokens.length - 1].en += text; prevEnd = s.index + text.length; continue; }
      tokens.push({ en: text, gap: sentence.slice(prevEnd, s.index) });
      prevEnd = s.index + text.length;
    }
  } else {
    const re = /\S+/g;
    let m;
    let prevEnd = 0;
    while ((m = re.exec(sentence))) {
      tokens.push({ en: m[0], gap: sentence.slice(prevEnd, m.index) });
      prevEnd = m.index + m[0].length;
    }
  }
  return tokens.map((t) => {
    const word = stripPunctGeneric(t.en);
    const lower = word.toLowerCase();
    return { en: t.en, gap: t.gap, word, lower, lemma: lower, pos: '', isName: false, rule: null, lookups: word ? [lower] : [] };
  });
}

function analyzeEnglish(sentence, toRussian) {
  // 1. Токены по пробелам с точными границами.
  const tokens = [];
  const re = /\S+/g;
  let m;
  let prevEnd = 0;
  while ((m = re.exec(sentence))) {
    tokens.push({ en: m[0], start: m.index, end: m.index + m[0].length, gap: sentence.slice(prevEnd, m.index), terms: [] });
    prevEnd = m.index + m[0].length;
  }

  // 2. Термы compromise с позициями.
  let terms = [];
  try {
    const doc = nlp(sentence);
    doc.compute('root');
    terms = doc.json({ offset: true }).flatMap((s) => s.terms);
  } catch {
    terms = [];
  }

  // 3. Привязка термов к токенам (неявные части сокращений — к тому же токену).
  let lastTok = -1;
  for (const t of terms) {
    let idx = -1;
    if (t.offset && t.offset.length > 0) {
      idx = tokens.findIndex((tok) => tok.start <= t.offset.start && t.offset.start < tok.end);
    }
    if (idx === -1) idx = lastTok;
    if (idx === -1) continue;
    tokens[idx].terms.push(t);
    lastTok = idx;
  }

  // 4. Фразовые глаголы: глагол с тегом PhrasalVerb + частица в следующем токене → один токен.
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];
    const last = tok.terms[tok.terms.length - 1];
    const first = next?.terms[0];
    if (
      last && first && next.terms.length === 1 &&
      last.tags.includes('PhrasalVerb') && !last.tags.includes('Particle') &&
      first.tags.includes('Particle') && !/[.,;:!?]$/.test(tok.en)
    ) {
      merged.push({ en: sentence.slice(tok.start, next.end), start: tok.start, end: next.end, gap: tok.gap, terms: [...tok.terms, ...next.terms], phrasal: true });
      i++;
    } else {
      merged.push(tok);
    }
  }

  // 5. Лемма, часть речи, правила.
  return merged.map((tok) => {
    const word = stripPunct(tok.en);
    const lower = word.toLowerCase();
    const termLemmas = tok.terms.map((t) => {
      if (t.implicit) return t.implicit;
      const n = t.normal || stripPunct(t.text).toLowerCase();
      if (BE[n]) return 'be';
      // У глагола в составе фразового («got back») compromise не всегда даёт root.
      if (!t.root && t.tags?.includes('Verb') && !t.tags.includes('Particle')) return infinitive(n);
      return t.root || n;
    });
    let lemma = termLemmas.filter(Boolean).join(' ').replace(/^i\b/, 'I') || lower;
    const tags = tok.terms.flatMap((t) => t.tags || []);
    const isName = tok.terms.length > 0 && tok.terms.every((t) => t.tags?.some((g) => ['ProperNoun', 'Person', 'Place', 'Organization'].includes(g)));
    let pos = [...new Set(tok.terms.map((t) => posOf(t.tags || [])))].join('+') || 'word';
    if (tok.phrasal) pos = 'phrasal verb';
    if (isName) { pos = 'name'; lemma = word; }

    let rule = null;
    const single = toRussian && tok.terms.length <= 1;
    if (single && ARTICLES[lower] && tags.includes('Determiner')) {
      rule = { ctx: '–', base: ARTICLES[lower] };
      pos = 'art';
      lemma = lower;
    } else if (single && BE[lower]) {
      rule = { ctx: BE[lower], base: BE_BASE };
      lemma = 'be';
      pos = 'verb';
    } else if (single && DO.has(lower) && tags.includes('Auxiliary')) {
      rule = { ctx: '–', base: 'вспомогательный глагол, не переводится' };
      lemma = 'do';
      pos = 'aux';
    } else if (single && lower === 'there' && tags.includes('There')) {
      rule = { ctx: '–', base: 'вводное there (there is / there are), не переводится' };
      pos = 'there';
    }

    const lookups = [];
    if (!rule && word) {
      lookups.push(isName ? word : lower);
      if (!isName && lemma && lemma.toLowerCase() !== lower) lookups.push(lemma.toLowerCase());
    }
    return { en: tok.en, gap: tok.gap, word, lower, lemma, pos, isName, rule, lookups };
  });
}
