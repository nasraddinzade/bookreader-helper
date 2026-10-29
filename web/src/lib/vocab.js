// Словарь на клиенте: ключи для подсветки сохранённого и вызовы API.

import { useEffect, useState } from 'react';
import { api } from './api.js';
import { onServerEvent } from './events.js';
import { wordKey } from '../../../shared/wordkey.js';

export { wordKey };

const keyCache = new Map(); // lang -> { words: Set, phrases: Map(firstWord -> [words[]]) }
const listeners = new Set();

async function loadKeys(lang) {
  const k = await api.get(`/api/vocab/keys?lang=${encodeURIComponent(lang)}`);
  const phrases = new Map();
  for (const p of k.phrases) {
    const words = p.split(' ').filter(Boolean);
    if (!words.length) continue;
    if (!phrases.has(words[0])) phrases.set(words[0], []);
    phrases.get(words[0]).push(words);
  }
  keyCache.set(lang, { words: new Set(k.words), phrases });
  listeners.forEach((fn) => fn());
}

onServerEvent((ev) => {
  if (ev.type === 'vocab') for (const lang of keyCache.keys()) loadKeys(lang).catch(() => {});
});

/** Хук: сохранённые ключи для языка книги; обновляется при любом изменении словаря. */
export function useSavedKeys(lang = 'en') {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    if (!keyCache.has(lang)) loadKeys(lang).catch(() => {});
    return () => listeners.delete(fn);
  }, [lang]);
  return keyCache.get(lang) || null;
}

/** Перевод слова без пунктуации, которую модель иногда переносит из предложения («поздно!»» → «поздно»). */
export function cleanCtx(ctx) {
  const s = String(ctx || '').trim();
  if (s === '–' || s === '—') return s;
  return s.replace(/^[«»"“”„‘’'.,;:!?…()\s]+|[«»"“”„‘’'.,;:!?…()\s]+$/g, '') || s;
}

export function isTokenSaved(t, keys) {
  if (!keys) return false;
  const l = wordKey(t.lemma);
  const e = wordKey(t.en);
  return (l && keys.words.has(l)) || (e && keys.words.has(e));
}

/** Индексы токенов предложения, входящих в сохранённые фразы. */
export function phraseTokenSet(tokens, keys) {
  const out = new Set();
  if (!keys || !keys.phrases.size) return out;
  const flat = []; // [{ w, k }] — слова токенов с индексом токена
  tokens.forEach((t, k) => { for (const w of wordKey(t.en).split(' ').filter(Boolean)) flat.push({ w, k }); });
  for (let i = 0; i < flat.length; i++) {
    const cands = keys.phrases.get(flat[i].w);
    if (!cands) continue;
    for (const words of cands) {
      if (i + words.length > flat.length) continue;
      let ok = true;
      for (let j = 1; j < words.length; j++) if (flat[i + j].w !== words[j]) { ok = false; break; }
      if (ok) for (let j = 0; j < words.length; j++) out.add(flat[i + j].k);
    }
  }
  return out;
}

export const vocabApi = {
  lookup: (kind, lang, text, lemma = '') =>
    api.get(`/api/vocab/lookup?kind=${kind}&lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(text)}&lemma=${encodeURIComponent(lemma)}`),
  save: (body) => api.post('/api/vocab', body),
  list: (kind) => api.get(`/api/vocab${kind ? `?kind=${kind}` : ''}`),
  remove: (id) => api.del(`/api/vocab/${id}`),
  removeExample: (id, eid) => api.del(`/api/vocab/${id}/examples/${eid}`),
  answer: (id, knew) => api.post(`/api/vocab/${id}/answer`, { knew }),
};
