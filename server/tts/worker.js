// Поток синтеза речи: Kokoro-82M (ONNX) на CPU с ограничением числа потоков.
// Получает текст, возвращает сжатый звук: Opus через ffmpeg, если он есть, иначе MP3 (lamejs).

import { parentPort, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { KokoroTTS } from 'kokoro-js';
import { env, StyleTextToSpeech2Model, AutoTokenizer } from '@huggingface/transformers';
import { Mp3Encoder } from '@breezystack/lamejs';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const RATE = 24000;
const MAX_CHUNK = 280; // длинные предложения синтезируем частями: модель обрезает слишком длинный ввод
const PAUSE_SAMPLES = Math.round(RATE * 0.12);

env.cacheDir = workerData.cacheDir;
env.allowRemoteModels = true;

/** Делит длинное предложение по знакам препинания, затем по пробелам. */
export function splitForTts(text) {
  const t = text.trim();
  if (t.length <= MAX_CHUNK) return [t];
  const parts = t.split(/(?<=[,;:—–)])\s+/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length <= MAX_CHUNK) { cur = (cur + ' ' + p).trim(); continue; }
    if (cur) out.push(cur);
    if (p.length <= MAX_CHUNK) { cur = p; continue; }
    cur = '';
    for (const w of p.split(/\s+/)) {
      if ((cur + ' ' + w).trim().length > MAX_CHUNK && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

function toMp3(pcm) {
  const enc = new Mp3Encoder(1, RATE, 48);
  const i16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  const chunks = [];
  for (let i = 0; i < i16.length; i += 1152) {
    const b = enc.encodeBuffer(i16.subarray(i, i + 1152));
    if (b.length) chunks.push(Buffer.from(b));
  }
  const end = enc.flush();
  if (end.length) chunks.push(Buffer.from(end));
  return Buffer.concat(chunks);
}

function toOpus(pcm) {
  return new Promise((resolve, reject) => {
    const ff = spawn(workerData.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], { windowsHide: true });
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg: ' + err.slice(0, 200)))));
    ff.stdin.end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });
}

const t0 = Date.now();
const [model, tokenizer] = await Promise.all([
  StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
    dtype: workerData.dtype,
    device: 'cpu',
    session_options: { intraOpNumThreads: workerData.threads, interOpNumThreads: 1 },
  }),
  AutoTokenizer.from_pretrained(MODEL_ID),
]);
const tts = new KokoroTTS(model, tokenizer);
parentPort.postMessage({ type: 'ready', voices: Object.entries(tts.voices).map(([id, v]) => ({ id, ...v })), loadMs: Date.now() - t0 });

let busy = Promise.resolve();
parentPort.on('message', (msg) => {
  busy = busy.then(async () => {
    const started = Date.now();
    try {
      const parts = [];
      for (const chunk of splitForTts(msg.text)) {
        const a = await tts.generate(chunk, { voice: msg.voice, speed: msg.speed });
        parts.push(a.audio);
      }
      const total = parts.reduce((n, p) => n + p.length, 0) + PAUSE_SAMPLES * (parts.length - 1);
      const pcm = new Float32Array(total);
      let at = 0;
      parts.forEach((p, i) => { pcm.set(p, at); at += p.length + (i < parts.length - 1 ? PAUSE_SAMPLES : 0); });
      const genMs = Date.now() - started;
      const data = workerData.ffmpeg ? await toOpus(pcm) : toMp3(pcm);
      parentPort.postMessage({ type: 'done', id: msg.id, data, ext: workerData.ffmpeg ? 'ogg' : 'mp3', duration: total / RATE, genMs });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id: msg.id, message: e.message || String(e) });
    }
  });
});
