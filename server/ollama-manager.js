// Ollama: поиск программы, запуск `ollama serve` с моделями на диске D, загрузка моделей, замер скорости.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, MODELS_DIR } from './config.js';
import { OLLAMA_URL, ollamaStatus, ollamaChat } from './providers/ollama.js';
import { emit } from './events.js';

export const OLLAMA_MODELS_DIR = path.join(MODELS_DIR, 'ollama');
fs.mkdirSync(OLLAMA_MODELS_DIR, { recursive: true });

const CANDIDATES = [
  process.env.OLLAMA_EXE,
  path.join(DATA_DIR, 'ollama', 'ollama.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'),
].filter(Boolean);

export function ollamaExe() {
  return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

let child = null;
let starting = null;

/** Убеждается, что Ollama запущен; если нет — запускает свой `ollama serve`. */
export async function ensureOllama() {
  if ((await ollamaStatus()).up) return;
  if (starting) return starting;
  const exe = ollamaExe();
  if (!exe) throw new Error('Ollama не установлен: нет ollama.exe в D:\\bookreader-data\\ollama');
  starting = (async () => {
    child = spawn(exe, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_MODELS: OLLAMA_MODELS_DIR,
        OLLAMA_HOST: '127.0.0.1:11434',
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_KEEP_ALIVE: '10m',
      },
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('exit', () => { child = null; });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await ollamaStatus({ fresh: true })).up) return;
    }
    throw new Error('Ollama не запустился за 30 секунд');
  })().finally(() => { starting = null; });
  return starting;
}

export function stopOllama() {
  if (child) { try { child.kill(); } catch { /* уже завершён */ } }
}

export async function ollamaInfo() {
  const st = await ollamaStatus({ fresh: true });
  return {
    installed: !!ollamaExe(),
    exe: ollamaExe(),
    running: st.up,
    ownProcess: !!child,
    models: st.models,
    modelsDir: OLLAMA_MODELS_DIR,
    pulling: pulling ? { ...pulling } : null,
    lastBench,
  };
}

// ---- Загрузка модели ------------------------------------------------------------

let pulling = null; // { model, status, completed, total }

export async function pullModel(model) {
  if (pulling) throw new Error(`Уже скачивается ${pulling.model}`);
  await ensureOllama();
  pulling = { model, status: 'starting', completed: 0, total: 0 };
  emit('ollama', { pulling });
  (async () => {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }) });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let lastEmit = 0;
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
          if (j.error) throw new Error(j.error);
          pulling = { model, status: j.status, completed: j.completed || pulling.completed, total: j.total || pulling.total };
          if (Date.now() - lastEmit > 1000) { lastEmit = Date.now(); emit('ollama', { pulling }); }
        }
      }
      pulling = null;
      emit('ollama', { pulled: model });
    } catch (e) {
      pulling = null;
      emit('ollama', { error: e.message });
    }
  })();
}

// ---- Замер скорости -----------------------------------------------------------

let lastBench = null; // { model, threads, n, seconds, secPerSentence, at }

/** Переводит n предложений и замеряет время. Возвращает секунд на предложение. */
export async function benchmark(provider, sentences, threads) {
  await ensureOllama();
  // Первый вызов загружает модель в память — его время не считаем.
  await ollamaChat({ model: provider.model, messages: [{ role: 'user', content: 'Hi' }], think: false, options: { num_predict: 1, num_thread: threads } });
  const t0 = Date.now();
  const out = await provider.glossBatch(sentences);
  const seconds = (Date.now() - t0) / 1000;
  lastBench = { model: provider.model, threads, n: sentences.length, seconds, secPerSentence: seconds / sentences.length, at: Date.now(), sample: out[0] };
  return { ...lastBench, all: out };
}
