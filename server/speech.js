// Данные для чтения вслух: словарь распознавателя Vosk и частотный список английских слов.
// Частотность нужна и для грамматики распознавания (частые слова — «ловушки» для ошибок),
// и для викторины (редкие слова абзаца вероятнее незнакомы).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS_DIR } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let vocab = null; // Set слов, которые модель умеет распознавать
let rank = null; // Map слово → место в частотном списке (0 — самое частое)

function load() {
  if (!rank) {
    rank = new Map();
    const lines = fs.readFileSync(path.join(HERE, 'data', 'en-freq.txt'), 'utf8').split('\n');
    let i = 0;
    for (const l of lines) if (l && !l.startsWith('#')) rank.set(l.trim(), i++);
  }
  if (!vocab) {
    const file = path.join(MODELS_DIR, 'vosk', 'vocab.txt');
    vocab = fs.existsSync(file) ? new Set(fs.readFileSync(file, 'utf8').split('\n')) : new Set();
  }
}

export function wordRank(word) {
  load();
  const r = rank.get(String(word).toLowerCase());
  return r === undefined ? null : r;
}

/** Для каждого слова: умеет ли его распознавать модель и насколько оно частое. */
export function speechWords(words) {
  load();
  return words.map((w) => {
    const k = String(w).toLowerCase();
    return { word: k, inVocab: vocab.size === 0 || vocab.has(k), rank: rank.has(k) ? rank.get(k) : null };
  });
}

/** Частые слова, известные модели, — добавляются в грамматику, чтобы ошибки не «притягивались» к тексту. */
export function commonWords(n = 3000) {
  load();
  const out = [];
  for (const [w] of rank) {
    if (out.length >= n) break;
    if (vocab.size === 0 || vocab.has(w)) out.push(w);
  }
  return out;
}
