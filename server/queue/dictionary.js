// Словарь лемм: словарные значения (base) для быстрого режима. Каждая лемма запрашивается один раз
// для всех книг; лёгкая модель (по умолчанию haiku), пачки по 150 лемм, один запрос за раз.

import { db, getSettings } from '../db.js';
import { emit } from '../events.js';
import { claudeDictionary } from '../providers/claude-code.js';
import { blocked } from './translate.js';

const BATCH = 150;
const MAX_TRIES = 3;

const nextGroup = db.prepare(`SELECT lang, tgt FROM lemma_dict WHERE base IS NULL AND tries < ${MAX_TRIES} LIMIT 1`);
const nextLemmas = db.prepare(`SELECT lemma FROM lemma_dict WHERE lang = ? AND tgt = ? AND base IS NULL AND tries < ${MAX_TRIES} ORDER BY at LIMIT ${BATCH}`);
const setBase = db.prepare('UPDATE lemma_dict SET base = ?, at = ? WHERE lang = ? AND tgt = ? AND lemma = ?');
const bumpTries = db.prepare('UPDATE lemma_dict SET tries = tries + 1 WHERE lang = ? AND tgt = ? AND lemma = ?');

let running = false;
let timer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (blocked() || getSettings().provider !== 'claude-code') break;
      const g = nextGroup.get();
      if (!g) break;
      const lemmas = nextLemmas.all(g.lang, g.tgt).map((r) => r.lemma);
      let answer = {};
      try {
        answer = await claudeDictionary(lemmas, { model: getSettings().dictModel || 'haiku', src: g.lang, tgt: g.tgt });
      } catch (e) {
        if (e.kind === 'limit' || e.kind === 'auth' || e.kind === 'unavailable') break; // очередь перевода сама сообщит
        console.warn('[dictionary]', e.message);
        await sleep(e.kind === 'busy' ? 20000 : 3000);
      }
      const byKey = new Map(Object.entries(answer || {}).map(([k, v]) => [k.toLowerCase().split('|')[0].trim(), String(v || '').trim()]));
      const now = Date.now();
      db.transaction(() => {
        for (const l of lemmas) {
          const base = byKey.get(l);
          if (base) setBase.run(base, now, g.lang, g.tgt, l);
          else bumpTries.run(g.lang, g.tgt, l);
        }
      })();
      emit('dict', {});
    }
  } finally {
    running = false;
  }
}

/** Запускает дозаполнение словаря (с небольшой задержкой, чтобы собрать леммы нескольких пачек). */
export function kickDictionary() {
  if (running || timer) return;
  timer = setTimeout(() => { timer = null; loop(); }, 5000);
}

const lookup = db.prepare('SELECT base FROM lemma_dict WHERE lang = ? AND tgt = ? AND lemma = ? AND base IS NOT NULL');

/** Словарное значение леммы или ''. */
export function dictBase(lang, tgt, lemma) {
  return lemma ? lookup.get(lang, tgt, String(lemma).toLowerCase())?.base || '' : '';
}

/** Подставляет base из словаря лемм в токены, у которых его нет. */
export function fillBases(lang, tgt, tokens) {
  for (const t of tokens) if (!t.base && t.lemma && t.pos !== 'name') t.base = dictBase(lang, tgt, t.lemma);
  return tokens;
}
