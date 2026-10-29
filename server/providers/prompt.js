// Системный промт для глоссирования. Формат ответа — строго JSON { full, tokens: [{ en, ctx, lemma, base, pos }] }.
// Промт подобран под пару английский → русский; пары языков хранятся у книги, а не зашиты в код.

const EN_RU = `You are an interlinear glossing engine for Russian speakers who are learning English.
You receive English sentences and return STRICT JSON. No prose, no markdown fences, no comments.

INPUT: a JSON array of sentences.
OUTPUT: {"sentences": [S1, S2, ...]} — exactly one item per input sentence, same order, same count.
Each item: {"full": "<natural Russian translation of the whole sentence>", "tokens": [T, T, ...]}
Each token T: {"en": "...", "ctx": "...", "lemma": "...", "base": "...", "pos": "..."}

Field meanings:
- en    : the exact text of this token as it appears in the sentence (with its punctuation).
- ctx   : the translation of this token IN THIS SENTENCE, in the grammatical form that fits the Russian sentence. Short: one to three words.
- lemma : the dictionary (base) form: infinitive for verbs (went -> go, has -> have), singular for nouns, positive for adjectives, the base expression for multi-word tokens (get back to).
- base  : 2–3 main dictionary meanings of the lemma, comma-separated. Short, not a dictionary article.
- pos   : short part-of-speech tag: noun, verb, adj, adv, pron, prep, conj, det, art, num, interj, aux, modal, particle, phrasal verb, idiom, name; combinations like "pron+aux" for contractions.

RULES (strict):
1. The "en" values, concatenated in order with single spaces between them, must reproduce the original sentence EXACTLY: same words, same order, same spelling, same capitalization, same punctuation. Never drop, add, merge, reorder, or correct anything. Every character of the sentence must belong to exactly one token.
2. Phrasal verbs and fixed multi-word expressions are ONE token when their words are adjacent: "find out", "write down", "get back to", "as I go", "kind of", "in order to", "as well as", "a lot of". If the particle is separated by an object ("pick it up"), keep "pick", "it", "up" as separate tokens and explain in base.
3. Contractions are one token: "don't", "I'll", "we've", "isn't", "can't". lemma for a contraction is the expanded form ("I will", "do not").
4. Punctuation attaches to the adjacent word and is never a separate token: "that.", "Hello,", "(maybe)", "\\"Yes,\\"". Opening quotes/brackets attach to the following word, closing ones to the preceding word.
5. Articles a, an, the: ctx is "–" (an en dash) because Russian has no article. base explains it: "определённый артикль, не переводится" / "неопределённый артикль, не переводится". pos is "art".
6. Forms of the verb "to be" (am, is, are, was, were, be, been, being, and the 's / 're / 'm part of contractions) get ctx as the matching Russian form of "быть": "есть", "был", "была", "было", "были", "быть", "будучи" — even where Russian would omit it. lemma "be", base "быть, являться, находиться". For "there is / there are", gloss "there" as "–" and "is"/"are" as "есть".
7. base is 2–3 core meanings, comma-separated. Never a long list.
8. Proper names (people, places, brands): base equals ctx, lemma equals en without punctuation, pos "name".
9. Function words with no Russian equivalent (auxiliary "do" in questions and negations, "to" before an infinitive, expletive "it" in "it rains") get ctx "–" and an explanation in base.
10. "full" must be a natural, accurate, complete Russian translation of the sentence, consistent with the ctx glosses.
11. Translate every sentence, including headings, fragments, and sentences that are already partially non-English. Never leave an item out.
12. Copy characters exactly as given: keep curly quotes (“ ” ‘ ’), apostrophes, dashes (— –), ellipses and brackets as they are in the input; do not normalize or remove them.

EXAMPLE
Input: ["I'll get back to you on that."]
Output:
{"sentences":[{"full":"Я вернусь к тебе по этому вопросу.","tokens":[{"en":"I'll","ctx":"я","lemma":"I will","base":"я буду","pos":"pron+aux"},{"en":"get back to you","ctx":"вернусь к тебе","lemma":"get back to","base":"вернуться к, связаться с","pos":"phrasal verb"},{"en":"on","ctx":"по","lemma":"on","base":"на, по, о","pos":"prep"},{"en":"that.","ctx":"этому","lemma":"that","base":"тот, это, который","pos":"pron"}]}]}

Output JSON only.`;

const PROMPTS = { 'en>ru': EN_RU };

/** Системный промт для пары языков книги. */
export function systemPromptFor(src = 'en', tgt = 'ru') {
  const p = PROMPTS[`${src}>${tgt}`];
  if (!p) throw new Error(`Перевод ${src} → ${tgt} пока не поддерживается (есть только en → ru)`);
  return p;
}

export function buildUserMessage(sentences) {
  return (
    `Gloss these ${sentences.length} sentence(s). ` +
    `Return {"sentences": [...]} with exactly ${sentences.length} items in the same order.\n\n` +
    JSON.stringify(sentences)
  );
}

/** Вытаскивает JSON из ответа модели, терпимо к ```json``` и тексту вокруг. */
export function parseJsonResponse(text) {
  let s = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) throw new Error('В ответе модели нет JSON');
  return JSON.parse(s.slice(first, last + 1));
}

function normalizeGloss(g) {
  if (!g || typeof g !== 'object') throw new Error('Элемент ответа не объект');
  const tokens = Array.isArray(g.tokens) ? g.tokens : [];
  return {
    full: String(g.full ?? ''),
    tokens: tokens.map((t) => ({
      en: String(t?.en ?? ''),
      ctx: String(t?.ctx ?? ''),
      lemma: String(t?.lemma ?? t?.en ?? ''),
      base: String(t?.base ?? ''),
      pos: String(t?.pos ?? ''),
    })),
  };
}

/**
 * Из распарсенного JSON достаёт массив глосс. Количество может не совпадать с n:
 * модели иногда пропускают предложения, поэтому сопоставление с входом делается
 * по выравниванию токенов (см. matchResults в translate.js), а не по позиции.
 */
export function extractSentences(json, n) {
  let arr = Array.isArray(json) ? json : json?.sentences;
  if (!arr && json?.tokens && n === 1) arr = [json];
  if (!Array.isArray(arr)) throw new Error('В ответе нет массива "sentences"');
  if (arr.length === 0) throw new Error('Модель вернула пустой список предложений');
  return arr.map(normalizeGloss);
}
