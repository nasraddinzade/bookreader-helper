// «Испытание чтеца» прямо в тексте главы: контроллер игры без собственного окна.
// Читалка рисует слова активного абзаца по tokenClass(), панель внизу — по state.
// Абзацы читаются по порядку: начать можно с первого непрочитанного абзаца главы
// (или перечитать уже прочитанный); после абзаца и викторины игра сама переходит к следующему.

import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { getSettings } from './settings.js';
import { speakText, stopSpeaking } from './tts.js';
import { ReadTracker, paragraphWords, similarWord, comboMultiplier, STRICTNESS } from '../../../shared/read-align.js';

const strictness = (name) => STRICTNESS[name] || STRICTNESS.normal;
const FINAL_DELAY_MS = 350; // ждём «свободный» распознаватель, чтобы сверить отрезок по времени
const NEXT_DELAY_MS = 1200; // пауза перед следующим абзацем

// Отладка без микрофона: window.__fakeMic = async (kind, text) => ArrayBuffer с записью
// (kind — 'main' для абзаца, 'repeat' для повтора слова). Без неё — настоящий микрофон.
const fakeMic = async (kind, text) => (typeof window.__fakeMic === 'function' ? window.__fakeMic(kind, text) : undefined);

let speechModule = null;
const speech = () => (speechModule ||= import('./speech.js'));

export const tokensOf = (s) => (s.gloss?.tokens?.length ? s.gloss.tokens : s.text.split(/\s+/).filter(Boolean).map((en, i) => ({ en, gap: i ? ' ' : '' })));

export class ReadGame {
  constructor() {
    this.listeners = new Set();
    this.version = 0;
    this.reset();
  }

  reset() {
    this.book = null;
    this.chapter = null;
    this.readParas = new Map(); // абзацы главы, уже прочитанные вслух: para → лучшие звёзды
    this.s = { phase: 'idle', para: null, error: '', notice: '', level: 0, tentative: 0, pops: [], mistake: null, result: null, game: null, questions: null, qIndex: 0, qState: null, quizPoints: 0, chapterDone: false };
    this.tracker = null;
    this.listen = null;
    this.finalTimer = null;
    this.inMistake = false;
    this.nextTimer = null;
  }

  // ---- Подписка для React ----
  subscribe = (fn) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = () => this.version;
  set(patch) { this.s = { ...this.s, ...patch }; this.changed(); }
  changed() { this.version++; this.listeners.forEach((fn) => fn()); }

  get active() { return this.s.phase !== 'idle'; }

  /** Привязка к открытой главе: прочитанные абзацы приходят с сервера. */
  async attach(book, chapter, strictness) {
    if (this.chapter && this.chapter.idx !== chapter.idx) this.stop();
    this.book = book;
    this.chapter = chapter;
    this.strictness = strictness;
    try {
      const paras = await api.get(`/api/game/paras?bookId=${book.id}&chapter=${chapter.idx}`);
      this.readParas = new Map(paras.map((p) => [p.para, p.stars]));
      this.changed();
    } catch { /* без отметок */ }
  }

  updateChapter(chapter) { if (this.chapter?.idx === chapter.idx) this.chapter = chapter; }

  /** Прохождение книги сброшено (из оглавления или библиотеки): игра останавливается, отметки исчезают. */
  onReset(bookId) {
    if (this.book?.id !== bookId) return;
    this.stop();
    this.readParas = new Map();
    this.changed();
  }

  paragraphs() {
    return [...new Set((this.chapter?.sentences || []).filter((x) => x.kind !== 'h').map((x) => x.para))];
  }

  firstUnread(after = -Infinity) {
    return this.paragraphs().find((p) => p > after && !this.readParas.has(p));
  }

  /**
   * Начать с абзаца para. Если раньше в главе есть непрочитанный абзац — игра переводит к нему:
   * абзацы проходятся по порядку. Уже прочитанный абзац можно перечитать.
   */
  async start(para) {
    const first = this.firstUnread();
    let target = para ?? first ?? this.paragraphs()[0];
    let notice = '';
    if (first !== undefined && target > first && !this.readParas.has(target)) {
      notice = 'Сначала дочитайте этот абзац — абзацы проходятся по порядку.';
      target = first;
    }
    if (target === undefined) return;
    this.stopListening();
    clearTimeout(this.nextTimer);
    stopSpeaking();
    this.set({ phase: 'loading', para: target, error: '', notice, mistake: null, result: null, questions: null, qState: null, quizPoints: 0, tentative: 0, pops: [], chapterDone: false });
    try {
      this.strictness = getSettings().readStrictness || this.strictness; // изменение в настройках действует сразу
      const sentences = this.chapter.sentences.filter((s) => s.para === target);
      const w = paragraphWords(sentences.map((s) => ({ id: s.id, text: s.text, tokens: tokensOf(s) })));
      const info = await api.post('/api/speech/words', { words: [...new Set(w.map((x) => x.w))] });
      const inVocab = new Map(info.map((x) => [x.word, x.inVocab]));
      for (const x of w) if (inVocab.get(x.w) === false) x.check = false;
      this.tracker = new ReadTracker(w, strictness(this.strictness));
      this.tracker.skipUnchecked();
      window.__raTracker = this.tracker; // для отладки из консоли
      const sp = await speech();
      await sp.loadSpeechModel();
      if (this.s.para !== target) return;
      this.listenMain();
    } catch (e) {
      this.set({ phase: 'idle', error: 'Не удалось подготовить распознавание: ' + e.message });
    }
  }

  stopListening() {
    clearTimeout(this.finalTimer);
    this.listen?.stop();
    this.listen = null;
  }

  stop() {
    this.stopListening();
    clearTimeout(this.nextTimer);
    stopSpeaking();
    this.inMistake = false;
    this.tracker = null;
    this.set({ phase: 'idle', para: null, mistake: null, notice: '', questions: null, qState: null });
  }

  pause() {
    if (this.s.phase !== 'listening') return;
    this.stopListening();
    this.set({ phase: 'paused' });
  }

  resume() { if (this.s.phase === 'paused') this.listenMain(); }

  popAt(i, text) {
    const id = Math.random();
    this.set({ pops: [...this.s.pops, { id, i, text }] });
    setTimeout(() => this.set({ pops: this.s.pops.filter((x) => x.id !== id) }), 950);
  }

  async listenMain() {
    const tr = this.tracker;
    if (!tr) return;
    this.set({ phase: 'listening', error: '' });
    const sp = await speech();
    let pending = null;
    try {
      this.listen = await sp.startListening({
        audio: await fakeMic('main', tr.words.slice(tr.pos).map((w) => w.w).join(' ')),
        onLevel: (level) => { if (Math.abs(level - this.s.level) > 0.05) this.set({ level }); },
        recognizers: [
          {
            grammar: [...new Set(tr.words.filter((x) => x.check).map((x) => x.w)), '[unk]'],
            onPartial: (text) => {
              if (this.tracker !== tr) return;
              const p = tr.partial(text);
              if (p.upTo !== this.s.tentative) this.set({ tentative: p.upTo });
              // [unk] на ожидаемом слове держится, а чтение ушло дальше — ошибка, не ждём паузы.
              if (p.unk && !tr.paused) this.onMistake(p.upTo, '');
            },
            onFinal: (r) => {
              pending = r.result || [];
              clearTimeout(this.finalTimer);
              this.finalTimer = setTimeout(() => {
                if (this.tracker !== tr) return;
                const res = pending;
                pending = null;
                this.applyEvents(tr.final(res));
              }, FINAL_DELAY_MS);
            },
          },
          { grammar: null, onFinal: (r) => tr.addFree(r.result) },
        ],
      });
    } catch (e) {
      this.set({ phase: 'paused', error: e.name === 'NotAllowedError' ? 'Нет доступа к микрофону: разрешите его для этой страницы в настройках браузера.' : 'Микрофон недоступен: ' + e.message });
    }
  }

  applyEvents(events) {
    const tr = this.tracker;
    for (const ev of events) {
      if (ev.type === 'ok') this.popAt(ev.i, `+${Math.round(10 * comboMultiplier(Math.max(0, tr.combo - 1)))}`);
      if (ev.type === 'error') { this.onMistake(ev.i, ev.heard); return; }
    }
    // Подсказка «сначала дочитайте этот абзац» больше не нужна, когда чтение пошло.
    this.set({ tentative: tr.pos, notice: events.some((e) => e.type === 'ok') ? '' : this.s.notice });
    if (tr.done) this.finish();
  }

  sayWord(w) {
    // Если браузер не дал воспроизвести звук, игра не должна зависнуть.
    return Promise.race([speakText(w, { id: 'ra-word', lang: this.book.lang }), new Promise((r) => setTimeout(r, 4000))]);
  }

  async onMistake(i, heard) {
    const tr = this.tracker;
    // Ошибка может прийти дважды (по промежуточной гипотезе и по итогу) — обрабатываем один раз.
    if (this.inMistake || !tr) return;
    this.inMistake = true;
    if (tr.state[i] !== 'error') tr.error(i, heard);
    this.stopListening();
    this.set({ phase: 'mistake', mistake: { i, heard, tries: 0, status: 'listen' } });
    await this.sayWord(tr.words[i].w);
    this.listenRepeat(i, 0);
  }

  async listenRepeat(i, tries) {
    const tr = this.tracker;
    if (!tr || this.s.phase !== 'mistake') return;
    const sp = await speech();
    const target = tr.words[i].w;
    const free = [];
    this.set({ mistake: { ...this.s.mistake, tries, status: tries ? 'again' : 'listening' } });
    let handled = false;
    this.listen = await sp.startListening({
      audio: await fakeMic('repeat', target),
      onLevel: (level) => { if (Math.abs(level - this.s.level) > 0.05) this.set({ level }); },
      recognizers: [
        {
          grammar: [target, '[unk]'],
          onFinal: (r) => {
            setTimeout(() => {
              if (handled || this.tracker !== tr) return;
              const got = (r.result || []).find((w) => w.word !== '[unk]');
              if (!got && !(r.result || []).length) return; // тишина
              handled = true;
              this.stopListening();
              // Повтор засчитывается мягче, чем чтение: уверенность ниже порога или похожее слово у «свободного».
              const cfg = strictness(this.strictness);
              if ((got && got.conf >= cfg.threshold - 0.1) || free.some((x) => similarWord(x.word, target, cfg.similarity))) {
                tr.fixed(i);
                this.popAt(i, '+5');
                this.resumeAfterMistake();
              } else {
                const next = tries + 1;
                this.set({ mistake: { ...this.s.mistake, tries: next, status: next >= 3 ? 'give-up' : 'again', heard: free.map((x) => x.word).join(' ') } });
                if (next < 3) this.sayWord(target).then(() => this.listenRepeat(i, next));
              }
            }, FINAL_DELAY_MS);
          },
        },
        { grammar: null, onFinal: (r) => free.push(...(r.result || [])) },
      ],
    });
  }

  resumeAfterMistake() {
    this.stopListening();
    this.inMistake = false;
    this.set({ mistake: null });
    if (this.tracker.done) this.finish(); else this.listenMain();
  }

  retryWord() { if (this.s.mistake) this.listenRepeat(this.s.mistake.i, 0); }
  skipWord() { if (!this.s.mistake) return; this.tracker.skipped(this.s.mistake.i); this.resumeAfterMistake(); }
  /** Распознавание ошиблось: слово засчитывается как прочитанное верно. */
  acceptWord() { if (!this.s.mistake) return; this.tracker.accept(this.s.mistake.i); this.resumeAfterMistake(); }

  async finish() {
    this.stopListening();
    const para = this.s.para;
    const result = this.tracker.summary();
    this.readParas.set(para, Math.max(this.readParas.get(para) || 0, result.stars));
    this.set({ phase: 'result', result });
    try {
      const game = await api.post('/api/game/read', { bookId: this.book.id, chapter: this.chapter.idx, para, stats: result });
      const questions = await api.post('/api/game/quiz', { bookId: this.book.id, chapter: this.chapter.idx, para });
      if (this.s.para !== para) return;
      this.set({ game, questions, qIndex: 0, qState: { tries: 0, picked: null, done: false } });
      if (questions.length) setTimeout(() => { if (this.s.para === para && this.s.phase === 'result') this.set({ phase: 'quiz' }); }, 1500);
      else this.scheduleNext();
    } catch (e) {
      this.set({ error: e.message });
    }
  }

  async answer(option) {
    const q = this.s.questions[this.s.qIndex];
    const st = this.s.qState;
    if (st.done) return;
    const right = option === q.correct;
    const tries = st.tries + 1;
    if (right || tries >= 2) {
      const res = right ? (tries === 1 ? 'first' : 'second') : 'wrong';
      this.set({ qState: { tries, picked: option, done: true, res } });
      const r = await api.post('/api/game/quiz/answer', { bookId: this.book.id, chapter: this.chapter.idx, para: this.s.para, item: q, result: res });
      this.set({ game: r.summary, quizPoints: this.s.quizPoints + r.points });
      speakText(q.word, { id: 'ra-q', lang: this.book.lang });
    } else {
      this.set({ qState: { tries, picked: option, done: false } });
    }
  }

  nextQuestion() {
    if (this.s.qIndex + 1 < this.s.questions.length) this.set({ qIndex: this.s.qIndex + 1, qState: { tries: 0, picked: null, done: false } });
    else this.scheduleNext();
  }

  /** Следующий непрочитанный абзац главы — сам, после короткой паузы. */
  scheduleNext() {
    const next = this.firstUnread(this.s.para);
    if (next === undefined) {
      this.set({ phase: 'chapter-done', chapterDone: true });
      return;
    }
    this.set({ phase: 'next', nextPara: next });
    clearTimeout(this.nextTimer);
    this.nextTimer = setTimeout(() => { if (this.s.phase === 'next') this.start(next); }, NEXT_DELAY_MS);
  }

  // ---- Отрисовка слов в тексте ----

  /** Класс токена sentenceId/tokenIdx активного абзаца: pending | next | reading | ok | auto | error | fixed | skipped. */
  tokenClass(sid, ti) {
    const tr = this.tracker;
    if (!tr) return '';
    let any = false;
    const st = [];
    let first = -1;
    tr.words.forEach((w, k) => {
      if (w.sid === sid && w.t === ti) { any = true; st.push(tr.state[k]); if (first < 0) first = k; }
    });
    if (!any) {
      // Токен без слов (тире, кавычки): «прочитан», если чтение уже ушло дальше.
      const after = tr.words.findIndex((w) => w.sid === sid && w.t > ti);
      return after >= 0 && after < tr.pos ? 'ok' : 'pending';
    }
    if (st.includes('error')) return 'error';
    if (st.every((x) => x === 'pending')) {
      if (first < this.s.tentative) return 'reading';
      return first === tr.pos && this.s.phase === 'listening' ? 'next' : 'pending';
    }
    if (st.includes('pending')) return 'reading';
    if (st.includes('skipped')) return 'skipped';
    if (st.includes('fixed')) return 'fixed';
    return st.every((x) => x === 'auto') ? 'auto' : 'ok';
  }

  popsFor(sid, ti) {
    const tr = this.tracker;
    if (!tr) return [];
    return this.s.pops.filter((p) => tr.words[p.i]?.sid === sid && tr.words[p.i].t === ti);
  }
}

export const readGame = new ReadGame();

/** Хук: перерисовка при любом изменении игры. */
export function useReadGame() {
  useSyncExternalStore(readGame.subscribe, readGame.snapshot, readGame.snapshot);
  return readGame;
}
