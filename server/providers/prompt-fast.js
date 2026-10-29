// Быстрый режим глоссирования. Токены, леммы и части речи считаются локально (compromise),
// модель возвращает только перевод предложения и по одному переводу на токен — так ответ
// в 4–5 раз короче, чем объект { en, ctx, lemma, base, pos } на каждое слово.
// Словарные значения (base) запрашиваются отдельно, один раз на лемму (см. DICT_*).

import { parseJsonResponse } from './prompt.js';

const FAST_EN_RU = `You translate English sentences into Russian for an interlinear reader.

INPUT: a JSON array of English sentences.
OUTPUT: {"s":[{"f":"...","g":[...]}, ...]} — exactly one item per input sentence, same order.
- "f": a natural, accurate, complete Russian translation of the whole sentence.
- "g": a flat list of pairs [english, russian, english, russian, ...] covering EVERY word of the sentence in order.
  english = the word copied from the sentence (without punctuation), or a multi-word unit;
  russian = its translation AS USED IN THIS SENTENCE, in the form that fits "f", one to three words, no punctuation.

RULES:
1. One pair per word. Phrasal verbs and fixed expressions (at most 4 words) are ONE pair when their words are adjacent: "find out", "look up", "get back to", "kind of", "as well as", "a lot of", "in order to", "at all".
2. Do not skip words, do not reorder, do not add words that are not in the English sentence.
3. "–" (en dash) for words with no Russian equivalent: articles a/an/the, auxiliary do/does/did, "to" before an infinitive, expletive "it" and "there".
4. Forms of "to be" (am, is, are, was, were, be, been) get the matching Russian form of «быть» (есть, был, была, было, были, быть), even where Russian omits it.
5. Proper names: transliterate (Alice → Алиса).
6. Output valid JSON only, no prose. In Russian text use «» for quotation marks, never the straight double quote.

EXAMPLE
Input: ["“Who are you?” said the Caterpillar.","She went to find out what kind of animal it was."]
Output: {"s":[{"f":"«Кто ты?» — спросила Гусеница.","g":["Who","кто","are","есть","you","ты","said","спросила","the","–","Caterpillar","Гусеница"]},{"f":"Она пошла выяснить, что это было за животное.","g":["She","она","went","пошла","to","–","find out","выяснить","what","что","kind of","за","animal","животное","it","это","was","было"]}]}`;

const DICT_EN_RU = `You are a concise English→Russian dictionary for learners.
INPUT: a JSON array of English lemmas (words or multi-word expressions), sometimes with a part of speech after "|".
OUTPUT: a JSON object {"lemma": "meanings", ...} with every input lemma as a key (exactly as given, without the "|pos" part).
"meanings" = 2–3 main Russian meanings, comma-separated, short (for example "идти, ехать, уходить"). For articles and function words give a short explanation in Russian. Output valid JSON only.`;

const PROMPTS = { 'en>ru': { fast: FAST_EN_RU, dict: DICT_EN_RU } };

function pair(src, tgt) {
  const p = PROMPTS[`${src}>${tgt}`];
  if (!p) throw new Error(`Перевод ${src} → ${tgt} пока не поддерживается (есть только en → ru)`);
  return p;
}

export const fastSystemPrompt = (src = 'en', tgt = 'ru') => pair(src, tgt).fast;
export const dictSystemPrompt = (src = 'en', tgt = 'ru') => pair(src, tgt).dict;

export function buildFastMessage(sentences) {
  return `Translate ${sentences.length} sentence(s). Return {"s":[...]} with exactly ${sentences.length} items in the same order.\n\n` + JSON.stringify(sentences);
}

/** [{ f, g }] из ответа модели. */
export function parseFast(text) {
  const j = parseJsonResponse(text);
  const arr = Array.isArray(j) ? j : j?.s || j?.sentences;
  if (!Array.isArray(arr)) throw new Error('В ответе нет массива "s"');
  return arr.map((x) => ({ f: String(x?.f ?? x?.full ?? ''), g: Array.isArray(x?.g) ? x.g.map((v) => String(v ?? '')) : null }));
}

export function buildDictMessage(lemmas) {
  return `Give meanings for these ${lemmas.length} lemmas.\n\n${JSON.stringify(lemmas)}`;
}

export function parseDict(text) {
  const j = parseJsonResponse(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('Словарь: ожидался объект');
  return j;
}
