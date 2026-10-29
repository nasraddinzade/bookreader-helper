// Провайдер перевода через локальный Ollama: тот же промт и формат, structured output по JSON-схеме,
// thinking выключен, число потоков ограничено.

import { systemPromptFor, buildUserMessage, extractSentences, parseJsonResponse } from './prompt.js';
import { ProviderError, unavailableError } from './errors.js';
import { ollamaChat } from './ollama.js';
import { ensureOllama } from '../ollama-manager.js';

const TOKEN = {
  type: 'object',
  properties: {
    en: { type: 'string' },
    ctx: { type: 'string' },
    lemma: { type: 'string' },
    base: { type: 'string' },
    pos: { type: 'string' },
  },
  required: ['en', 'ctx', 'lemma', 'base', 'pos'],
};
export const GLOSS_SCHEMA = {
  type: 'object',
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: { full: { type: 'string' }, tokens: { type: 'array', items: TOKEN } },
        required: ['full', 'tokens'],
      },
    },
  },
  required: ['sentences'],
};

export function ollamaProvider({ model = 'qwen3:8b', threads = 6, src = 'en', tgt = 'ru' } = {}) {
  const system = systemPromptFor(src, tgt);
  return {
    id: 'ollama',
    name: `ollama:${model}`,
    model,
    maxBatch: 6, // 8B-модель на CPU: маленькие пачки надёжнее и дают прогресс чаще
    async glossBatch(texts, { signal } = {}) {
      try {
        await ensureOllama();
      } catch (e) {
        throw unavailableError(e.message);
      }
      let j;
      try {
        j = await ollamaChat({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: buildUserMessage(texts) }],
          format: GLOSS_SCHEMA,
          think: false,
          options: { temperature: 0.2, num_thread: Math.max(1, Number(threads) || 6), num_ctx: 8192, num_predict: 6000 },
          signal,
        });
      } catch (e) {
        if (/model .* not found|pull/i.test(e.message)) throw unavailableError(`Модель ${model} не скачана. Откройте Настройки → Ollama → «Скачать модель».`);
        if (/ECONNREFUSED|fetch failed/i.test(e.message)) throw unavailableError('Ollama не отвечает: ' + e.message);
        throw new ProviderError(e.message, { retryable: true });
      }
      const content = j.message?.content || '';
      let parsed;
      try {
        parsed = parseJsonResponse(content);
      } catch (e) {
        throw new ProviderError('Ollama вернул невалидный JSON' + (j.done_reason === 'length' ? ' (ответ обрезан)' : ''), {
          retryable: true,
          reduceBatch: texts.length > 1,
        });
      }
      return extractSentences(parsed, texts.length);
    },
  };
}
