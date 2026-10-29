// Встроенный переводчик Chrome (Translator API, Chrome 138+): бесплатно, на устройстве.
// Фрагмент переводится в контексте: предложение с фрагментом в квадратных скобках,
// из скобок в ответе берётся перевод. Если скобки потерялись — перевод фрагмента отдельно.

const translators = new Map();

// В некоторых сборках Chromium API есть, но промисы не завершаются — без таймаута всплывашка зависнет.
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(what + ': нет ответа')), ms))]);
}

export function chromeTranslatorSupported() {
  return typeof self !== 'undefined' && 'Translator' in self;
}

async function getTranslator(src, tgt) {
  const key = `${src}>${tgt}`;
  if (!translators.has(key)) {
    const p = withTimeout(self.Translator.create({ sourceLanguage: src, targetLanguage: tgt }), 15000, 'Переводчик Chrome').catch((e) => {
      translators.delete(key);
      throw e;
    });
    translators.set(key, p);
  }
  return translators.get(key);
}

function extractMarked(translated) {
  const m = String(translated || '').match(/\[([^[\]]{1,200})\]/);
  if (!m) return '';
  return m[1].replace(/\s+/g, ' ').trim().replace(/^[\s"'«»„“”.,;:!?]+|[\s"'«»„“”.,;:!?]+$/g, '');
}

/** Переводит фрагмент text из предложения sentence. Бросает ошибку, если API нет. */
export async function chromeTranslateInContext(text, sentence, src = 'en', tgt = 'ru') {
  if (!chromeTranslatorSupported()) throw new Error('Встроенного переводчика нет в этом браузере');
  const avail = await withTimeout(self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt }), 3000, 'Переводчик Chrome');
  if (avail === 'unavailable') throw new Error('Переводчик Chrome не поддерживает эту пару языков');
  const tr = await getTranslator(src, tgt);
  const at = sentence.indexOf(text);
  if (at >= 0) {
    const marked = sentence.slice(0, at) + '[' + text + ']' + sentence.slice(at + text.length);
    const inCtx = extractMarked(await withTimeout(tr.translate(marked), 15000, 'Переводчик Chrome'));
    if (inCtx) return inCtx;
  }
  return String(await withTimeout(tr.translate(text), 15000, 'Переводчик Chrome')).trim();
}
