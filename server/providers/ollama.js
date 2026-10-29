// Клиент Ollama (локальный сервер на 127.0.0.1:11434).

export const OLLAMA_URL = process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : 'http://127.0.0.1:11434';

/** Запущен ли Ollama (быстрая проверка, кэш на 15 секунд). */
let upMemo = { at: 0, up: false, models: [] };
export async function ollamaStatus({ fresh = false } = {}) {
  if (!fresh && Date.now() - upMemo.at < 15000) return upMemo;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    upMemo = { at: Date.now(), up: r.ok, models: (j.models || []).map((m) => m.name) };
  } catch {
    upMemo = { at: Date.now(), up: false, models: [] };
  }
  return upMemo;
}

/**
 * Чат с моделью. Ответ читается потоком: на CPU генерация идёт минутами, а fetch в Node
 * обрывает запрос, если заголовки ответа не пришли за 5 минут.
 * Возвращает { message: { content }, done_reason, eval_count, eval_duration, total_duration }.
 */
export async function ollamaChat({ model, messages, format, options = {}, think = false, signal, timeoutMs = 30 * 60 * 1000 }) {
  const body = { model, messages, stream: true, think, options, keep_alive: '10m' };
  if (format) body.format = format;
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig });
  if (!r.ok) {
    const text = await r.text();
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error || msg; } catch { /* не JSON */ }
    throw new Error(`Ollama: ${msg}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let last = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error('Ollama: ' + j.error);
      content += j.message?.content || '';
      if (j.done) last = j;
    }
  }
  return { ...last, message: { role: 'assistant', content } };
}
