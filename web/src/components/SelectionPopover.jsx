// Перевод выделения: выделите мышью или долгим нажатием несколько слов внутри предложения —
// выделение прилипает к целым словам, рядом появляется перевод фрагмента в контексте предложения,
// кнопки «Прослушать» и «Запомнить» (в раздел «Фразы»).
// Перевод: сервер (кэш → Ollama) → встроенный переводчик Chrome → Claude Code (haiku).

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { speakText, useSpeakingId } from '../lib/tts.js';
import { vocabApi } from '../lib/vocab.js';
import { chromeTranslateInContext, chromeTranslatorSupported } from '../lib/translator.js';

const DEBOUNCE_MS = 300;

function selectedTokens(range, en) {
  const out = [];
  for (const tok of en.querySelectorAll('.tok')) {
    const w = tok.querySelector('.w');
    if (!w) continue;
    const r = document.createRange();
    r.selectNodeContents(w);
    // Строгое пересечение: начало выделения раньше конца слова и конец выделения позже начала слова.
    const overlaps = range.compareBoundaryPoints(Range.END_TO_START, r) < 0 && range.compareBoundaryPoints(Range.START_TO_END, r) > 0;
    if (overlaps) out.push(tok);
  }
  return out;
}

async function translate(text, sentence, lang, tgt) {
  const r = await api.post('/api/selection', { text, sentence, lang, tgt });
  if (r.ru) return r;
  if (chromeTranslatorSupported()) {
    try {
      const ru = await chromeTranslateInContext(text, sentence, lang, tgt);
      if (ru) {
        api.post('/api/selection/cache', { text, sentence, lang, tgt, ru, via: 'chrome' }).catch(() => {});
        return { ru, via: 'chrome' };
      }
    } catch (e) {
      console.warn('[selection] chrome translator', e);
    }
  }
  return api.post('/api/selection', { text, sentence, lang, tgt, allowClaude: true });
}

const VIA = { ollama: 'Ollama', chrome: 'переводчик Chrome', claude: 'Claude' };

export default function SelectionPopover({ book, chapter, getSentence }) {
  const [state, setState] = useState(null);
  const reqRef = useRef(0);
  const speakingId = useSpeakingId();
  const lang = book.lang;
  const tgt = book.targetLang;

  useEffect(() => {
    let timer = null;
    const place = (range) => {
      const rect = range.getBoundingClientRect();
      return { left: rect.left + rect.width / 2, top: rect.bottom + 6, bottom: rect.top - 6 };
    };
    const handle = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setState(null); return; }
        const range = sel.getRangeAt(0);
        const c = range.commonAncestorContainer;
        const el = c.nodeType === 1 ? c : c.parentElement;
        const en = el?.closest('.row .en');
        if (!en) { setState(null); return; }
        const toks = selectedTokens(range, en);
        if (toks.length < 2 && !(toks.length === 1 && /\s/.test(toks[0].dataset.en))) { setState(null); return; }
        const text = toks.map((t, k) => (k ? t.dataset.gap || ' ' : '') + t.dataset.en).join('')
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const index = Number(en.closest('.row').dataset.index);
        const sentence = getSentence(index);
        if (!sentence || !text) { setState(null); return; }
        // Выделение прилипает к целым словам.
        try {
          const r = document.createRange();
          r.setStartBefore(toks[0].querySelector('.w'));
          r.setEndAfter(toks[toks.length - 1].querySelector('.w'));
          if (r.toString() !== range.toString()) { sel.removeAllRanges(); sel.addRange(r); }
        } catch { /* выделение могло измениться */ }
        const id = ++reqRef.current;
        const pos = place(sel.getRangeAt(0));
        if (state && state.text === text && state.index === index) { setState((s) => s && { ...s, pos }); return; }
        setState({ text, index, pos, loading: true, ru: '', via: '', error: '', saved: null });
        try {
          const [tr, existing] = await Promise.all([
            translate(text, sentence.text, lang, tgt),
            vocabApi.lookup('phrase', lang, text).catch(() => null),
          ]);
          if (id === reqRef.current) setState((s) => s && { ...s, ru: tr.ru || '', via: tr.via, loading: false, saved: existing?.examples?.some((e) => e.sentence === sentence.text) ? 'exists' : existing ? 'other' : null });
        } catch (e) {
          if (id === reqRef.current) setState((s) => s && { ...s, error: e.message, loading: false });
        }
      }, DEBOUNCE_MS);
    };
    const onScroll = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      setState((s) => (s ? { ...s, pos: place(sel.getRangeAt(0)) } : s));
    };
    const onKey = (e) => { if (e.key === 'Escape') { setState(null); document.getSelection()?.removeAllRanges(); } };
    document.addEventListener('selectionchange', handle);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', handle);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [getSentence, lang, tgt, state]);

  if (!state) return null;

  const save = async () => {
    const sentence = getSentence(state.index);
    const r = await vocabApi.save({
      kind: 'phrase',
      lang,
      tgt,
      text: state.text,
      lemma: '',
      ctx: state.ru,
      base: state.ru,
      pos: 'phrase',
      example: {
        en: state.text,
        ctx: state.ru,
        sentence: sentence.text,
        sentenceRu: sentence.gloss?.full || '',
        bookId: book.id,
        bookTitle: book.title,
        chapter: chapter.idx,
        chapterTitle: chapter.title,
        sentenceIdx: sentence.idx,
      },
    });
    setState((s) => s && { ...s, saved: r.created ? 'created' : r.exampleAdded ? 'example' : 'exists' });
  };

  const left = Math.min(Math.max(state.pos.left, 170), window.innerWidth - 170);
  const below = state.pos.top + 140 < window.innerHeight;
  return (
    <div
      className="sel-pop"
      style={below ? { left, top: state.pos.top } : { left, bottom: window.innerHeight - state.pos.bottom }}
      onPointerDown={(e) => e.preventDefault()} /* не сбрасывать выделение при клике по всплывашке */
      role="dialog"
      aria-label="Перевод выделения"
    >
      <div className="sel-phrase">
        <span>{state.text}</span>
      </div>
      <div className="sel-ru">
        {state.loading ? <span className="muted">перевожу…</span> : state.error ? <span className="error">{state.error}</span> : state.ru || <span className="muted">нет перевода</span>}
        {state.via && !state.loading && <span className="muted small"> · {VIA[state.via] || state.via}</span>}
      </div>
      <div className="sel-actions">
        <button className={`small${speakingId === 'sel' ? ' active' : ''}`} onClick={() => speakText(state.text, { id: 'sel', lang })}>🔊 Прослушать</button>
        {state.saved === 'created' ? <span className="ok-text">Сохранено в «Фразы»</span>
          : state.saved === 'example' ? <span className="ok-text">Пример добавлен</span>
          : state.saved === 'exists' ? <span className="muted">✓ Уже запомнено</span>
          : <button className="primary small" onClick={save} disabled={state.loading || !state.ru}>Запомнить</button>}
        <button className="icon" title="Закрыть" onClick={() => { setState(null); document.getSelection()?.removeAllRanges(); }}>×</button>
      </div>
    </div>
  );
}
