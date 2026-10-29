import { normalizeWs } from './segment.js';

// Сравнение терпимо к типографским кавычкам/тире и регистру,
// но не к пропущенным или добавленным символам.
function norm(s) {
  return s
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/ /g, ' ')
    .toLowerCase();
}

/**
 * Проверяет, что токены модели посимвольно восстанавливают предложение,
 * и возвращает токены с полем gap — пробелами из оригинала перед токеном.
 * en каждого токена заменяется на точный срез оригинала.
 */
export function alignTokens(sentence, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return { ok: false, reason: 'no tokens' };
  const src = sentence;
  let pos = 0;
  const out = [];
  for (const t of tokens) {
    if (!t || typeof t.en !== 'string') return { ok: false, reason: 'bad token' };
    const en = normalizeWs(t.en);
    if (!en) continue;
    let gap = '';
    while (pos < src.length && /\s/.test(src[pos])) gap += src[pos++];
    const slice = src.slice(pos, pos + en.length);
    if (norm(slice) !== norm(en)) {
      return { ok: false, reason: `at ${pos}: expected "${slice}" but model gave "${en}"` };
    }
    out.push({ ...t, en: slice, gap });
    pos += en.length;
  }
  if (src.slice(pos).trim() !== '') return { ok: false, reason: `leftover "${src.slice(pos)}"` };
  if (out.length === 0) return { ok: false, reason: 'no tokens' };
  return { ok: true, tokens: out };
}

/** Собирает предложение обратно из выровненных токенов (для проверок). */
export function joinTokens(tokens) {
  return tokens.map((t) => (t.gap ?? '') + t.en).join('');
}
