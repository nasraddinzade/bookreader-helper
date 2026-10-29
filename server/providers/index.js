// Адаптер перевода. Один интерфейс у всех провайдеров:
//   provider.glossBatch(sentences, { signal }) -> [{ full, tokens: [{ en, ctx, lemma, base, pos }] }]
//   provider.name — ключ кэша (провайдер + модель).

import { claudeCodeProvider } from './claude-code.js';
import { analyze } from '../../shared/gloss-local.js';
import { ollamaProvider } from './ollama-gloss.js';

export function stubProvider() {
  const gloss = (text) => ({
    full: '',
    tokens: text.split(/\s+/).filter(Boolean).map((w) => ({ en: w, ctx: '', lemma: '', base: '', pos: '' })),
  });
  return {
    id: 'stub',
    name: 'stub',
    cacheable: false,
    // STUB_DELAY_MS — искусственная задержка, чтобы проверять паузу и возобновление очереди.
    glossBatch: async (texts) => {
      const delay = Number(process.env.STUB_DELAY_MS) || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return texts.map(gloss);
    },
  };
}

/** Провайдер по настройкам и паре языков книги. */
export function createProvider(settings, src = 'en', tgt = 'ru') {
  switch (settings.provider) {
    case 'stub':
      return stubProvider();
    case 'ollama':
      return { cacheable: true, ...ollamaProvider({ model: settings.ollamaModel, threads: settings.ollamaThreads, src, tgt }) };
    case 'claude-code':
    default:
      return { cacheable: true, ...claudeCodeProvider({ model: settings.claudeModel, effort: settings.claudeEffort, mode: settings.glossMode, src, tgt }) };
  }
}
