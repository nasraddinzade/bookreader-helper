// Озвучка. Новое воспроизведение прерывает предыдущее, подсветка снимается по окончанию
// воспроизведения (onended / onend), а не по таймеру.
// Источники: готовый файл предложения с сервера (Kokoro) → генерация на лету через сервер →
// системный speechSynthesis, если сервер озвучку не умеет.

import { useSyncExternalStore } from 'react';

let speakingId = null;
let current = null; // { stop() }
let seq = 0;
const listeners = new Set();

function setSpeaking(id) {
  speakingId = id;
  listeners.forEach((fn) => fn());
}

export function useSpeakingId() {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => speakingId,
    () => null,
  );
}

export function stopSpeaking() {
  seq++;
  current?.stop();
  current = null;
  setSpeaking(null);
}

const audio = typeof Audio !== 'undefined' ? new Audio() : null;

/** Проигрывает url; промис завершается строкой 'ended' | 'error' | 'stopped'. */
export function playUrl(url, id) {
  stopSpeaking();
  const my = ++seq;
  return new Promise((resolve) => {
    if (!audio) { resolve('error'); return; }
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      audio.onended = audio.onerror = null;
      if (my === seq) { current = null; setSpeaking(null); }
      resolve(how);
    };
    current = { stop: () => { audio.pause(); finish('stopped'); } };
    audio.onended = () => finish('ended');
    audio.onerror = () => finish('error');
    audio.src = url;
    setSpeaking(id);
    audio.play().catch((e) => finish(e?.name === 'AbortError' ? 'stopped' : 'error'));
  });
}

function speakSystem(text, id, rate = 1) {
  stopSpeaking();
  const my = ++seq;
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') { resolve('error'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find((x) => /^en[-_]/i.test(x.lang));
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-US';
    u.rate = rate;
    let done = false;
    const finish = (how) => { if (done) return; done = true; if (my === seq) { current = null; setSpeaking(null); } resolve(how); };
    u.onend = () => finish('ended');
    u.onerror = () => finish('error');
    current = { stop: () => { speechSynthesis.cancel(); finish('stopped'); } };
    setSpeaking(id);
    speechSynthesis.speak(u);
  });
}

let serverTts = null; // null — не проверяли; true/false — есть ли озвучка на сервере
export function setServerTts(v) { serverTts = v; }

/** Произнести произвольный текст (слово, фразу, пример). */
export async function speakText(text, { id = text, lang = 'en' } = {}) {
  const clean = String(text || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!clean) return 'error';
  if (serverTts !== false) {
    const how = await playUrl(`/api/tts?lang=${encodeURIComponent(lang)}&text=${encodeURIComponent(clean)}`, id);
    if (how !== 'error') return how;
  }
  return speakSystem(clean, id);
}

/** Произнести предложение книги: готовый файл, если он есть, иначе как произвольный текст. */
export function speakSentence(s, { id = `sent-${s.id}`, lang = 'en' } = {}) {
  if (s.audio) return playUrl(`/api/audio/${s.id}`, id);
  return speakText(s.text, { id, lang });
}
