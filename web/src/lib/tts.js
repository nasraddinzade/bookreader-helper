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
  if (book?.playing) { book.playing = false; snap(); }
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

// ---- Аудиокнига ------------------------------------------------------------------
// Непрерывное чтение главы: текущее предложение подсвечивается, следующее заранее загружается
// во второй <audio>, поэтому переход между предложениями без паузы. Подсветка снимается по ended.

const nextAudio = typeof Audio !== 'undefined' ? new Audio() : null;
const bookListeners = new Set();
let book = null; // { sentences, index, playing, lang, onIndex, onEnd }

function bookNotify() { bookListeners.forEach((fn) => fn()); }
let bookSnapshot = { active: false, playing: false, index: -1 };
function snap() {
  bookSnapshot = book ? { active: true, playing: book.playing, index: book.index } : { active: false, playing: false, index: -1 };
  bookNotify();
}

export function useAudiobook() {
  return useSyncExternalStore(
    (fn) => { bookListeners.add(fn); return () => bookListeners.delete(fn); },
    () => bookSnapshot,
    () => bookSnapshot,
  );
}

const sentenceUrl = (s) => `/api/audio/${s.id}`;

let preloaded = null; // { el, url } — следующее предложение, загруженное заранее

function preload(i, playingEl) {
  if (!book || !nextAudio) return;
  const s = book.sentences[i];
  if (!s) return;
  const url = sentenceUrl(s);
  const el = playingEl === audio ? nextAudio : audio;
  el.src = url;
  el.preload = 'auto';
  el.load();
  preloaded = { el, url };
  // Ещё одно предложение вперёд: сервер начнёт его генерировать, пока играют эти два.
  const s2 = book.sentences[i + 1];
  if (s2 && !s2.audio) fetch(sentenceUrl(s2), { method: 'HEAD' }).catch(() => {});
}

async function playIndex(i) {
  if (!book) return;
  if (i >= book.sentences.length) { const end = book.onEnd; stopAudiobook(); end?.(); return; }
  book.index = i;
  book.playing = true;
  snap();
  book.onIndex?.(i);
  const s = book.sentences[i];
  const my = book;
  const url = sentenceUrl(s);
  // Следующий файл уже загружен во второй элемент — играем его без ожидания загрузки.
  const ready = preloaded && preloaded.url === url && preloaded.el.src.endsWith(url) ? preloaded.el : null;
  const el = ready || (preloaded?.el === audio ? nextAudio : audio);
  preloaded = null;
  const how = await playElement(el, `sent-${s.id}`, () => preload(i + 1, el), ready ? null : url);
  if (book !== my || !book.playing) return;
  if (how === 'ended' || how === 'error') playIndex(book.index + 1);
}

// Как playUrl, но с выбором элемента и колбэком после старта воспроизведения.
function playElement(el, id, onStart, url) {
  current?.stop();
  const my = ++seq;
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      el.onended = el.onerror = null;
      if (my === seq) { current = null; setSpeaking(null); }
      resolve(how);
    };
    current = { stop: () => { el.pause(); finish('stopped'); }, audiobook: true };
    el.onended = () => finish('ended');
    el.onerror = () => finish('error');
    if (url) el.src = url;
    el.currentTime = 0;
    setSpeaking(id);
    el.play().then(onStart).catch((e) => finish(e?.name === 'AbortError' ? 'stopped' : 'error'));
  });
}

/** Запускает аудиокнигу с предложения startIndex. */
export function startAudiobook({ sentences, startIndex = 0, lang = 'en', onIndex, onEnd }) {
  stopSpeaking();
  book = { sentences, index: startIndex, playing: true, lang, onIndex, onEnd };
  playIndex(startIndex);
}

export function pauseAudiobook() {
  if (!book || !book.playing) return;
  book.playing = false;
  current?.stop();
  snap();
}

export function resumeAudiobook() {
  if (!book || book.playing) return;
  playIndex(book.index);
}

export function seekAudiobook(delta) {
  if (!book) return;
  const i = Math.max(0, Math.min(book.sentences.length - 1, book.index + delta));
  book.playing = true;
  current?.stop();
  playIndex(i);
}

export function jumpAudiobook(i) {
  if (!book) return;
  current?.stop();
  playIndex(i);
}

/** Обновляет список предложений главы (например, появились новые файлы озвучки). */
export function updateAudiobookSentences(sentences) {
  if (book) book.sentences = sentences;
}

export function stopAudiobook() {
  if (!book) return;
  book = null;
  current?.stop();
  current = null;
  setSpeaking(null);
  snap();
}
