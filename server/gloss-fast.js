// Быстрый режим: токены строятся локально из самого предложения (поэтому всегда посимвольно
// совпадают с ним), а переводы слов от модели сопоставляются с токенами по тексту.
// Модель возвращает пары [english, russian, ...]; многословная единица («find out») склеивает
// соседние токены в один, пропущенное моделью слово остаётся без перевода (или по локальному правилу).

import { analyze } from '../shared/gloss-local.js';

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’`´]/g, "'")
  .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
  .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const LOOKAHEAD = 3; // на сколько слов вперёд искать единицу, если модель пропустила слово
const MAX_UNIT = 4;

/** Пары [en, ru, en, ru, ...] → [{ en, ru }]. */
export function toUnits(g) {
  const out = [];
  for (let i = 0; i + 1 < (g || []).length; i += 2) out.push({ en: String(g[i] ?? ''), ru: String(g[i + 1] ?? '').trim() });
  return out;
}

/**
 * Сопоставляет единицы модели с локальными токенами.
 * Возвращает { tokens: [{ en, gap, ctx, lemma, base, pos }], coverage } — coverage: доля слов с переводом.
 */
export function mapUnits(sentence, units, lang = 'en', tgt = 'ru') {
  const local = analyze(sentence, lang, tgt);
  const words = []; // { w, k } — слова локальных токенов с индексом токена
  local.forEach((t, k) => { for (const w of norm(t.en).split(' ').filter(Boolean)) words.push({ w, k }); });
  const ctx = new Array(local.length).fill('');
  const joinTo = new Array(local.length).fill(-1); // токен k склеивается с токеном joinTo[k]
  let p = 0;
  for (const u of units) {
    const uw = norm(u.en).split(' ').filter(Boolean);
    if (!uw.length) continue;
    let at = -1;
    for (let d = 0; d <= LOOKAHEAD && at < 0; d++) {
      const q = p + d;
      if (q + uw.length > words.length) break;
      if (uw.every((w, i) => words[q + i].w === w)) at = q;
    }
    if (at < 0) continue; // единицы нет в предложении — модель что-то добавила
    const ks = [...new Set(words.slice(at, at + uw.length).map((x) => x.k))];
    const first = ks[0];
    const ru = u.ru === '+' ? '' : u.ru;
    // Склеиваем не больше MAX_UNIT слов: длиннее — это уже не выражение, а кусок фразы.
    if (ks.length > 1 && uw.length <= MAX_UNIT) for (const k of ks.slice(1)) { joinTo[k] = first; ctx[k] = ''; }
    if (ru && !ctx[first]) ctx[first] = ru;
    p = at + uw.length;
  }

  // Сборка: склеенные токены объединяются в один, текст — точные срезы оригинала.
  const out = [];
  local.forEach((t, k) => {
    const target = joinTo[k];
    if (target >= 0 && out.length) {
      const prev = out[out.length - 1];
      prev.en += (t.gap || '') + t.en;
      prev.lemma = [prev.lemma, t.lemma].filter(Boolean).join(' ');
      prev.multi = true;
      prev.hasVerb = prev.hasVerb || /verb/.test(t.pos);
      return;
    }
    out.push({
      en: t.en,
      gap: k === 0 ? (t.gap || '') : t.gap,
      ctx: ctx[k] || t.rule?.ctx || '',
      lemma: t.lemma || t.lower || '',
      base: t.rule?.base || '',
      pos: t.pos || '',
      multi: /\s/.test(t.en.trim()),
      hasVerb: /verb/.test(t.pos),
    });
  });
  const tokens = out.map((t) => ({
    en: t.en,
    gap: t.gap,
    ctx: t.ctx,
    lemma: t.lemma,
    base: t.base,
    pos: t.multi && t.pos !== 'name' ? (t.hasVerb ? 'phrasal verb' : 'idiom') : t.pos,
  }));
  const needing = tokens.filter((t) => /\p{L}/u.test(t.en));
  const coverage = needing.length ? needing.filter((t) => t.ctx).length / needing.length : 1;
  return { tokens, coverage };
}
