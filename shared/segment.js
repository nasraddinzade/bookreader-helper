export function normalizeWs(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Разбивает текст на предложения через Intl.Segmenter.
 * Абзацы (разделены пустой строкой) сегментируются отдельно, переносы строк
 * внутри абзаца схлопываются в пробел, чтобы предложение всегда было одной строкой.
 * Возвращает { sentences: string[], paragraphOf: number[] }.
 */
export function splitIntoSentences(text, lang = 'en') {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map(normalizeWs)
    .filter(Boolean);

  let segmenter = null;
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try { segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' }); } catch { segmenter = new Intl.Segmenter('en', { granularity: 'sentence' }); }
  }

  const sentences = [];
  const paragraphOf = [];
  paragraphs.forEach((p, pi) => {
    const parts = segmenter
      ? [...segmenter.segment(p)].map((s) => s.segment)
      : p.split(/(?<=[.!?]["'”’)]?)\s+(?=["'“‘(]?\p{Lu}|\d)/u);
    for (const s of mergeFalseBreaks(parts.map((x) => x.trim()).filter(Boolean), lang)) {
      sentences.push(s);
      paragraphOf.push(pi);
    }
  });
  return { sentences, paragraphOf };
}

// V8 применяет только базовые правила UAX #29 без списка исключений CLDR,
// поэтому "Mr. Smith" или "Dr. Brown" режутся по точке. Склеиваем сегмент со следующим, если
// он заканчивается известным сокращением или инициалом, либо следующий начинается со строчной
// буквы (например, «"Where is it?" asked Tom.»).
const ABBREV_BY_LANG = {
  en: 'Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Ft|Messrs|Gen|Col|Capt|Lt|Sgt|Cmdr|Rev|Hon|Pres|Gov|Sen|Rep|vs|cf|e\\.g|i\\.e|No|Nos|Inc|Ltd|Co|Corp|Bros|Fig|Figs|Vol|Ch|pp|approx|Dept|Est|Ave|Blvd|Rd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec',
  es: 'Sr|Sra|Srta|Dr|Dra|Ud|Uds|Vd|Vds|D|Dña|Lic|Ing|Prof|Av|Avda|núm|pág|etc|p\\.ej',
  fr: 'M|Mme|Mlle|Dr|Pr|St|Ste|av|bd|p\\.ex|cf|etc',
  de: 'Hr|Fr|Dr|Prof|Nr|Str|bzw|usw|z\\.B|d\\.h|u\\.a|ca|evtl|ggf|vgl',
  it: 'Sig|Sig\\.ra|Sig\\.na|Dott|Dr|Prof|Ing|Avv|ecc|pag|p\\.es',
  pt: 'Sr|Sra|Srta|Dr|Dra|Prof|Eng|Av|pág|etc|p\\.ex',
  ru: 'г|гг|т|тт|ул|д|кв|стр|проф|др|тел|см|напр|т\\.е|т\\.д|т\\.п',
};
const abbrevCache = new Map();
function abbrevRe(lang) {
  const code = (lang || 'en').split('-')[0];
  if (!abbrevCache.has(code)) {
    const list = ABBREV_BY_LANG[code] ? ABBREV_BY_LANG[code] + '|' : '';
    abbrevCache.set(code, new RegExp(`(?:^|[\\s("“‘'«—–])(?:${list}\\p{Lu})\\.["”’')»]*$`, 'u'));
  }
  return abbrevCache.get(code);
}

export function mergeFalseBreaks(parts, lang = 'en') {
  const out = [];
  const re = abbrevRe(lang);
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && (re.test(prev) || /^[\p{Ll}]/u.test(part))) {
      out[out.length - 1] = prev + ' ' + part;
    } else {
      out.push(part);
    }
  }
  return out;
}
