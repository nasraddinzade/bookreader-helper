// Перевод выделенного фрагмента в контексте предложения.
// Порядок: кэш → Ollama (если запущен) → встроенный переводчик Chrome на стороне браузера.
// Если браузерного переводчика нет, клиент просит запасной вариант — Claude Code (haiku).

import crypto from 'node:crypto';
import { db, getSettings } from './db.js';
import { ollamaStatus, ollamaChat } from './providers/ollama.js';
import { claudeText } from './providers/claude-code.js';

const keyOf = (lang, tgt, text, sentence) =>
  crypto.createHash('sha256').update(`${lang}>${tgt}\n${text.trim().toLowerCase()}\n${sentence}`).digest('hex');

const prompt = (text, sentence) =>
  `Sentence: "${sentence}"\nFragment: "${text}"\n` +
  'Translate the fragment into Russian exactly as it is used in this sentence (a natural phrase, not word by word). ' +
  'Reply with the Russian translation of the fragment only, without quotes or explanations.';

const cleanAnswer = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n')[0].replace(/^["«“']+|["»”']+$/g, '').trim();

export function cachedSelection({ text, sentence, lang = 'en', tgt = 'ru' }) {
  return db.prepare('SELECT ru, via FROM selection_cache WHERE key = ?').get(keyOf(lang, tgt, text, sentence)) || null;
}

export function storeSelection({ text, sentence, lang = 'en', tgt = 'ru', ru, via }) {
  if (!ru) return;
  db.prepare('INSERT OR REPLACE INTO selection_cache (key, ru, via, at) VALUES (?, ?, ?, ?)').run(keyOf(lang, tgt, text, sentence), ru, via, Date.now());
}

/** { ru, via } или { ru: null, via: 'client' } — тогда переводит браузер. */
export async function translateSelection({ text, sentence, lang = 'en', tgt = 'ru', allowClaude = false }) {
  const hit = cachedSelection({ text, sentence, lang, tgt });
  if (hit) return { ...hit, cached: true };
  const st = await ollamaStatus();
  const model = getSettings().ollamaModel;
  if (st.up && (st.models.includes(model) || st.models.includes(model + ':latest'))) {
    const j = await ollamaChat({
      model,
      messages: [{ role: 'user', content: prompt(text, sentence) }],
      options: { temperature: 0.2, num_thread: Number(getSettings().ollamaThreads) || 6 },
      timeoutMs: 120000,
    });
    const ru = cleanAnswer(j.message?.content);
    if (ru) { storeSelection({ text, sentence, lang, tgt, ru, via: 'ollama' }); return { ru, via: 'ollama' }; }
  }
  if (allowClaude) {
    const ru = cleanAnswer(await claudeText(prompt(text, sentence)));
    if (ru) { storeSelection({ text, sentence, lang, tgt, ru, via: 'claude' }); return { ru, via: 'claude' }; }
  }
  return { ru: null, via: 'client' };
}
