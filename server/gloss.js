// Проверка ответа модели: сопоставление с предложениями по выравниванию, а не по позиции,
// и последняя страховка — починка токенов так, чтобы их конкатенация посимвольно давала предложение.

import { alignTokens, joinTokens } from '../shared/align.js';
import { normalizeWs } from '../shared/segment.js';

/** Нормализация для сравнения (как в align.js): типографские кавычки/тире и регистр не важны. */
function norm(s) {
  return s
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/ /g, ' ')
    .toLowerCase();
}

/**
 * Сопоставляет ответ модели с входными предложениями по выравниванию токенов.
 * Возвращает массив той же длины, что texts; null — предложения в ответе нет.
 */
export function matchResults(texts, glosses) {
  const used = new Set();
  const out = texts.map(() => null);
  texts.forEach((s, i) => {
    for (let k = 0; k < glosses.length; k++) {
      if (used.has(k)) continue;
      if (alignTokens(s, glosses[k].tokens).ok) { used.add(k); out[i] = glosses[k]; break; }
    }
  });
  // Количество совпало — невыровненные берём по позиции, дальше их проверит finalize/повтор.
  if (glosses.length === texts.length) {
    texts.forEach((_, i) => { if (!out[i] && !used.has(i)) { out[i] = glosses[i]; used.add(i); } });
  }
  return out;
}

const clean = (t) => ({ en: t.en, gap: t.gap ?? '', ctx: t.ctx || '', lemma: t.lemma || '', base: t.base || '', pos: t.pos || '' });

/** { gloss, aligned } — gloss с точными срезами оригинала, если выравнивание прошло. */
export function finalize(sentence, gloss) {
  const a = alignTokens(sentence, gloss.tokens);
  if (a.ok) return { aligned: true, gloss: { full: gloss.full, tokens: a.tokens.map(clean), ...(gloss.fast ? { fast: true } : {}) } };
  return { aligned: false, reason: a.reason, gloss };
}

/**
 * Починка невыровненного ответа: каждый токен ищется в оригинале от текущей позиции;
 * пропущенные моделью символы приклеиваются к соседнему токену, ненайденные токены отбрасываются.
 * Результат всегда восстанавливает предложение посимвольно.
 */
export function repairTokens(sentence, tokens) {
  const src = sentence;
  const nsrc = norm(src);
  const out = [];
  const empty = { ctx: '', lemma: '', base: '', pos: '' };
  let pos = 0;
  // Добавляет токен из src[from, to): ведущие пробелы уходят в gap, хвостовые остаются следующему.
  const push = (from, to, t) => {
    let s = from;
    while (s < to && /\s/.test(src[s])) s++;
    let e = to;
    while (e > s && /\s/.test(src[e - 1])) e--;
    if (e <= s) return from;
    out.push({ ...t, en: src.slice(s, e), gap: src.slice(from, s) });
    return e;
  };
  // Символы без токена: вплотную к предыдущему токену — приклеиваем к нему, иначе отдельный токен.
  const absorb = (to) => {
    const chunk = src.slice(pos, to);
    if (!chunk.trim()) return;
    if (out.length && !/^\s/.test(chunk)) {
      const glued = chunk.match(/^\S+/)[0];
      out[out.length - 1].en += glued;
      pos += glued.length;
    }
    if (src.slice(pos, to).trim()) pos = push(pos, to, empty);
  };
  for (const t of tokens || []) {
    const en = normalizeWs(String(t?.en || ''));
    if (!en) continue;
    let idx = nsrc.indexOf(norm(en), pos);
    let len = en.length;
    if (idx === -1 || idx - pos > 60) {
      const bare = en.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      idx = bare ? nsrc.indexOf(norm(bare), pos) : -1;
      len = bare.length;
      if (idx === -1 || idx - pos > 60) continue; // токена нет в предложении — выбрасываем
    }
    absorb(idx);
    pos = push(pos, idx + len, t);
  }
  absorb(src.length);
  const tokensOut = out.map(clean);
  if (!tokensOut.length || joinTokens(tokensOut) !== src.trimEnd()) {
    // Не должно случаться, но инвариант дороже подсказок: слова без перевода.
    const words = [];
    src.trimEnd().replace(/(\s*)(\S+)/g, (_, gap, w) => { words.push({ en: w, gap, ...empty }); return ''; });
    return words;
  }
  return tokensOut;
}
