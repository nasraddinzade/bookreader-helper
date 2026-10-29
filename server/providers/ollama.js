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

export async function ollamaChat({ model, messages, format, options = {}, think = false, signal, timeoutMs = 10 * 60 * 1000 }) {
  const body = { model, messages, stream: false, think, options, keep_alive: '10m' };
  if (format) body.format = format;
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`Ollama: ${r.status} ${text.slice(0, 200)}`); }
  if (!r.ok || j.error) throw new Error('Ollama: ' + (j.error || r.status));
  return j; // { message: { content }, eval_count, eval_duration, total_duration, ... }
}
