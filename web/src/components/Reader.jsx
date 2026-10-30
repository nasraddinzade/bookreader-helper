import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/route.js';
import { useServerEvents } from '../lib/events.js';
import { useSettings, updateSettings, getSettings, HINT_MODES, HINT_MODE_LABELS, RU_MODES, RU_MODE_LABELS } from '../lib/settings.js';
import { useSavedKeys, isTokenSaved, phraseTokenSet, cleanCtx } from '../lib/vocab.js';
import {
  speakSentence, speakText, useSpeakingId, useAudiobook, startAudiobook, pauseAudiobook, resumeAudiobook,
  seekAudiobook, jumpAudiobook, stopAudiobook, updateAudiobookSentences,
} from '../lib/tts.js';
import WordCard from './WordCard.jsx';
import SelectionPopover from './SelectionPopover.jsx';
import ReadAloud from './ReadAloud.jsx';
import QueueStatus from './QueueStatus.jsx';

function Token({ t, id, hintMode, tapped, saved, inPhrase, onTap, onOpen }) {
  const ptype = useRef('mouse');
  const cls = ['tok', tapped && 'tapped', saved && 'saved', inPhrase && 'saved-phrase'].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      data-tok={id}
      data-en={t.en}
      data-gap={t.gap ?? ' '}
      onPointerDown={(e) => { ptype.current = e.pointerType; }}
      onClick={(e) => {
        // Клик в конце выделения нескольких слов — это не открытие карточки.
        const sel = document.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim().includes(' ')) return;
        // На сенсорном экране в режиме «по наведению» первый тап показывает подсказку,
        // второй тап по тому же слову открывает карточку.
        if (hintMode === 'hover' && ptype.current === 'touch' && !tapped && t.ctx) { onTap(id); return; }
        onOpen?.(e);
      }}
    >
      <span className="g">{cleanCtx(t.ctx) || ' '}</span>
      <span className="w">{t.en}</span>
      {hintMode === 'hover' && t.ctx ? <span className="tip">{cleanCtx(t.ctx)}</span> : null}
    </span>
  );
}

const Row = memo(function Row({ s, isNewPara, hintMode, ruMode, ruOpen, tappedTok, keys, speaking, onTap, onToggleRu, onOpenToken, onPlay, onRetry, paraStart, onReadAloud }) {
  const sid = `s${s.idx}`;
  const done = s.status === 'done' && s.gloss;
  const showRuInline = ruMode === 'click' && ruOpen;
  const phraseToks = useMemo(() => (done ? phraseTokenSet(s.gloss.tokens, keys) : null), [done, s.gloss, keys]);
  return (
    <div
      data-index={s.idx}
      className={['row', isNewPara && 'para', s.kind === 'h' && 'heading', s.status, speaking && 'speaking'].filter(Boolean).join(' ')}
    >
      <button
        className={`num${ruMode === 'click' ? ' clickable' : ''}${ruOpen ? ' open' : ''}`}
        title={ruMode === 'click' ? 'Показать перевод предложения' : `Предложение ${s.idx + 1}`}
        onClick={() => ruMode === 'click' && onToggleRu(s.idx)}
        tabIndex={ruMode === 'click' ? 0 : -1}
      >
        {s.idx + 1}
      </button>
      <span className="ctl">
        <button className={`play${speaking ? ' active' : ''}`} title="Прослушать предложение" onClick={() => onPlay(s)}>▶</button>
        {paraStart && s.kind !== 'h' && <button className="mic" title="Испытание чтеца: прочитать этот абзац вслух" onClick={() => onReadAloud(s.para)}>🎙</button>}
      </span>
      <div className="en">
        {done ? (
          s.gloss.tokens.map((t, k) => (
            <span key={k}>
              {k > 0 ? (t.gap || ' ') : ''}
              <Token
                t={t}
                id={`${sid}t${k}`}
                hintMode={hintMode}
                tapped={tappedTok === `${sid}t${k}`}
                saved={isTokenSaved(t, keys)}
                inPhrase={phraseToks?.has(k)}
                onTap={onTap}
                onOpen={() => onOpenToken?.(s, t, k)}
              />
            </span>
          ))
        ) : (
          <span className="plain">{s.text}</span>
        )}
        {showRuInline && (
          <div className="ru-inline">{done ? (s.gloss.full || <span className="muted">—</span>) : <span className="muted">ещё не переведено</span>}</div>
        )}
      </div>
      {ruMode === 'show' && (
        <div className="ru">
          {done ? (s.gloss.full || <span className="muted">—</span>)
            : s.status === 'error' ? <span className="err" title={s.error || ''}>ошибка перевода <button className="small" onClick={() => onRetry(s)}>Повторить</button></span>
            : <span className="muted">{s.status === 'pending' ? 'ждёт перевода…' : ''}</span>}
        </div>
      )}
    </div>
  );
});

export default function Reader({ param }) {
  const [bookIdStr, chParam, sentParam] = param.split('/');
  const bookId = Number(bookIdStr);
  const settings = useSettings();
  const hintMode = settings.hintMode || 'visible';
  const ruMode = settings.ruColumn || 'show';
  const immersive = !!settings.immersive;
  const fontScale = Math.min(1.6, Math.max(0.8, Number(settings.fontScale) || 1));

  // Режим погружения прячет верхнюю панель приложения — она вне читалки, поэтому класс на body.
  useEffect(() => {
    document.body.classList.toggle('immersive', immersive);
    return () => document.body.classList.remove('immersive');
  }, [immersive]);
  const toggleImmersive = () => updateSettings({ immersive: !getSettings().immersive });
  const changeScale = (d) => updateSettings({ fontScale: Math.round(Math.min(1.6, Math.max(0.8, (Number(getSettings().fontScale) || 1) + d)) * 100) / 100 });
  const [book, setBook] = useState(null);
  const [error, setError] = useState('');
  const [chapterIdx, setChapterIdx] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [tapped, setTapped] = useState(null);
  const [ruOpen, setRuOpen] = useState(() => new Set());
  const [tocOpen, setTocOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [card, setCard] = useState(null); // { sentence, token }
  const [readAloud, setReadAloud] = useState(null); // номер абзаца в испытании чтеца
  const keys = useSavedKeys(book?.lang || 'en');
  const speakingId = useSpeakingId();
  const chapterRef = useRef(null);
  chapterRef.current = chapter;
  const ab = useAudiobook();
  const continueAudiobook = useRef(false);
  const audiobookChapter = useRef(null); // глава, которую сейчас читает аудиокнига
  const scrollTarget = useRef(null); // номер предложения, к которому прокрутить после загрузки главы
  const topSentence = useRef(0);
  const refetchTimer = useRef(null);

  const loadBook = useCallback(() => api.get(`/api/books/${bookId}`).then(setBook).catch((e) => setError(e.message)), [bookId]);
  const loadBookmarks = useCallback(() => api.get(`/api/books/${bookId}/bookmarks`).then(setBookmarks).catch(() => {}), [bookId]);

  // Первая загрузка: книга, затем глава из адреса или сохранённой позиции.
  useEffect(() => {
    let alive = true;
    api.get(`/api/books/${bookId}`).then((b) => {
      if (!alive) return;
      setBook(b);
      const ch = chParam !== undefined && chParam !== '' ? Number(chParam) : b.position.chapter;
      const sent = sentParam !== undefined ? Number(sentParam) : (ch === b.position.chapter ? b.position.sentence : 0);
      scrollTarget.current = sent;
      setChapterIdx(Math.min(Math.max(0, ch), b.chapters.length - 1));
    }).catch((e) => setError(e.message));
    loadBookmarks();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // Переход по ссылке «к месту в книге» внутри уже открытой читалки.
  useEffect(() => {
    if (!book || chParam === undefined || chParam === '') return;
    const ch = Number(chParam);
    scrollTarget.current = sentParam !== undefined ? Number(sentParam) : 0;
    if (ch !== chapterIdx) setChapterIdx(ch);
    else scrollToSentence(scrollTarget.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chParam, sentParam]);

  const loadChapter = useCallback(async (idx) => {
    const c = await api.get(`/api/books/${bookId}/chapters/${idx}`);
    setChapter((prev) => (prev && prev.idx === c.idx ? { ...c } : c));
    return c;
  }, [bookId]);

  useEffect(() => {
    if (chapterIdx === null) return;
    setChapter(null);
    setRuOpen(new Set());
    loadChapter(chapterIdx).catch((e) => setError(e.message));
    api.put(`/api/books/${bookId}/position`, { chapter: chapterIdx, sentence: scrollTarget.current ?? 0 }).catch(() => {});
  }, [chapterIdx, bookId, loadChapter]);

  useEffect(() => {
    if (!chapter) return;
    if (continueAudiobook.current) { continueAudiobook.current = false; startBook(0); }
    else if (audiobookChapter.current === chapter.idx) updateAudiobookSentences(chapter.sentences);
    else if (audiobookChapter.current !== null) { audiobookChapter.current = null; stopAudiobook(); } // ушли в другую главу
  }, [chapter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Уход из читалки останавливает аудиокнигу.
  useEffect(() => () => stopAudiobook(), []);

  // Прокрутка к нужному предложению, когда глава отрисована.
  useEffect(() => {
    if (!chapter || scrollTarget.current === null) return;
    const n = scrollTarget.current;
    scrollTarget.current = null;
    requestAnimationFrame(() => scrollToSentence(n));
  }, [chapter]);

  function scrollToSentence(n) {
    if (!n) { window.scrollTo({ top: 0 }); return; }
    document.querySelector(`.rows [data-index="${n}"]`)?.scrollIntoView({ block: 'start' });
  }

  // Позиция чтения: первое видимое предложение, сохраняется с задержкой.
  useEffect(() => {
    if (!chapter) return undefined;
    let timer = null;
    const onScroll = () => {
      const rows = document.querySelectorAll('.rows .row');
      const top = 110;
      let lo = 0, hi = rows.length - 1, found = 0;
      while (lo <= hi) { // двоичный поиск первой строки, нижний край которой ниже шапки
        const mid = (lo + hi) >> 1;
        if (rows[mid].getBoundingClientRect().bottom > top) { found = mid; hi = mid - 1; } else lo = mid + 1;
      }
      const idx = Number(rows[found]?.dataset.index || 0);
      if (idx === topSentence.current) return;
      topSentence.current = idx;
      clearTimeout(timer);
      timer = setTimeout(() => {
        api.put(`/api/books/${bookId}/position`, { chapter: chapter.idx, sentence: idx }).catch(() => {});
      }, 1200);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); clearTimeout(timer); };
  }, [chapter, bookId]);

  // Живое обновление: переведённые предложения текущей главы подгружаются по событиям сервера.
  useServerEvents((ev) => {
    const refetch = (ms) => {
      if (!refetchTimer.current) {
        refetchTimer.current = setTimeout(() => { refetchTimer.current = null; loadChapter(chapterIdx).catch(() => {}); }, ms);
      }
    };
    // Словарь лемм дополнился — у слов главы появились словарные значения.
    if (ev.type === 'dict') { refetch(3000); return; }
    if (ev.bookId !== bookId) return;
    if ((ev.type === 'sentence' || ev.type === 'audio') && ev.chapter === chapterIdx) refetch(800);
    if (ev.type === 'chapter-done' || ev.type === 'queue') loadBook();
  });

  // Горячие клавиши: H — подсказки, T — колонка перевода, ←/→ с Alt — главы.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey) return;
      if (readAloud !== null) return; // клавиши читалки не работают поверх испытания чтеца
      const k = e.key.toLowerCase();
      if (k === 'h' || k === 'р') { e.preventDefault(); cycleHintMode(); }
      else if (k === 't' || k === 'е') { e.preventDefault(); toggleRuColumn(); }
      else if (e.key === 'Escape') {
        // Сначала закрываются всплывающие окна, следующий Esc выводит из режима погружения.
        if (!card && !tocOpen && !tapped && immersive) toggleImmersive();
        setTapped(null); setTocOpen(false); setCard(null);
      }
      else if (k === 'a' || k === 'ф') { e.preventDefault(); toggleAudiobook(); }
      else if (k === 'f' || k === 'а') { e.preventDefault(); toggleImmersive(); }
      else if (k === 'r' || k === 'к') { e.preventDefault(); readAloudHere(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); changeScale(0.05); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); changeScale(-0.05); }
      else if (ab.active && e.key === 'ArrowDown' && e.shiftKey) { e.preventDefault(); seekAudiobook(1); }
      else if (ab.active && e.key === 'ArrowUp' && e.shiftKey) { e.preventDefault(); seekAudiobook(-1); }
      else if (e.altKey && e.key === 'ArrowRight') goChapter(1);
      else if (e.altKey && e.key === 'ArrowLeft') goChapter(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Тап вне слова убирает всплывающую подсказку.
  useEffect(() => {
    if (!tapped) return undefined;
    const onDown = (e) => { if (!e.target.closest?.('.tok.tapped')) setTapped(null); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [tapped]);

  const cycleHintMode = () => {
    const cur = getSettings().hintMode || 'visible';
    updateSettings({ hintMode: HINT_MODES[(HINT_MODES.indexOf(cur) + 1) % HINT_MODES.length] });
    setTapped(null);
  };
  const toggleRuColumn = () => {
    const cur = getSettings().ruColumn || 'show';
    updateSettings({ ruColumn: cur === 'show' ? 'hide' : 'show' });
  };
  const setRuMode = (m) => updateSettings({ ruColumn: m });

  const goChapter = (delta) => {
    if (!book || chapterIdx === null) return;
    const next = chapterIdx + delta;
    if (next < 0 || next >= book.chapters.length) return;
    openChapter(next, 0);
  };
  const openChapter = (idx, sentence = 0) => {
    setTocOpen(false);
    navigate(`read/${bookId}/${idx}/${sentence}`);
  };

  const onOpenToken = useCallback((s, t) => {
    setTapped(null);
    speakText(t.en, { id: `tok-${s.id}`, lang: book?.lang || 'en' });
    setCard({ sentence: s, token: t });
  }, [book?.lang]);
  const onPlay = useCallback((s) => {
    // В режиме аудиокниги клик по предложению переносит чтение туда; иначе — одно предложение.
    if (ab.active) jumpAudiobook(s.idx);
    else speakSentence(s, { id: `sent-${s.id}`, lang: book?.lang || 'en' });
  }, [book?.lang, ab.active]);

  const scrollIntoViewIfNeeded = (idx) => {
    const el = document.querySelector(`.rows [data-index="${idx}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 110 || r.bottom > window.innerHeight - 20) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const startBook = (from) => {
    const c = chapterRef.current;
    if (!c) return;
    audiobookChapter.current = c.idx;
    startAudiobook({
      sentences: c.sentences,
      startIndex: from,
      lang: book.lang,
      onIndex: scrollIntoViewIfNeeded,
      onEnd: () => {
        // Конец главы — продолжаем со следующей.
        if (chapterIdx < book.chapters.length - 1) { continueAudiobook.current = true; goChapter(1); }
      },
    });
  };
  const toggleAudiobook = () => {
    if (!ab.active) startBook(topSentence.current || 0);
    else if (ab.playing) pauseAudiobook();
    else resumeAudiobook();
  };
  const onRetry = useCallback((s) => api.post(`/api/sentences/${s.id}/retry`).then(() => loadChapter(s ? chapterRef.current.idx : 0)), [loadChapter]);
  const getSentence = useCallback((idx) => chapterRef.current?.sentences?.[idx] || null, []);

  // Испытание чтеца: абзацы главы, в которых есть не только заголовки.
  const paragraphs = () => [...new Set((chapterRef.current?.sentences || []).filter((x) => x.kind !== 'h').map((x) => x.para))];
  const openReadAloud = useCallback((para) => {
    stopAudiobook();
    setCard(null);
    setReadAloud(para);
  }, []);
  const readAloudHere = () => {
    const c = chapterRef.current;
    if (!c) return;
    const top = c.sentences[topSentence.current] || c.sentences[0];
    const list = paragraphs();
    openReadAloud(list.find((p) => p >= (top?.para ?? 0)) ?? list[0]);
  };

  const toggleRu = useCallback((idx) => {
    setRuOpen((prev) => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; });
  }, []);

  const addBookmark = async () => {
    if (chapterIdx === null) return;
    await api.post(`/api/books/${bookId}/bookmarks`, { chapter: chapterIdx, sentence: topSentence.current });
    loadBookmarks();
  };
  const removeBookmark = async (id) => {
    await api.del(`/api/books/${bookId}/bookmarks/${id}`);
    loadBookmarks();
  };

  const chInfo = book?.chapters?.[chapterIdx];
  const rows = useMemo(() => chapter?.sentences || [], [chapter]);

  if (error) return <div className="page"><p className="error">{error} <a href="#/library">В библиотеку</a></p></div>;
  if (!book) return <div className="page"><p className="muted">Загрузка…</p></div>;

  return (
    <div className={`reader mode-${hintMode} ru-${ruMode}${immersive ? ' immersive' : ''}`} style={{ '--scale': fontScale }}>
      <div className="reader-bar">
        <button className="small" onClick={() => setTocOpen((v) => !v)} title="Оглавление и закладки">☰ Главы</button>
        <div className="reader-title" title={`${book.title} — ${chInfo?.title || ''}`}>
          <span className="rt-book">{book.title}</span>
          <span className="rt-ch">{chInfo?.title}</span>
        </div>
        <div className="reader-progress">
          {chInfo && (
            <span title="Переведено предложений в главе">
              {chInfo.translated}/{chInfo.total}
              <progress value={chInfo.translated} max={chInfo.total || 1} />
            </span>
          )}
          <QueueStatus bookId={bookId} compact />
        </div>
        <div className="reader-tools">
          <button className="small" onClick={() => goChapter(-1)} disabled={!chapterIdx} title="Предыдущая глава (Alt+←)">‹</button>
          <button className="small" onClick={() => goChapter(1)} disabled={chapterIdx >= book.chapters.length - 1} title="Следующая глава (Alt+→)">›</button>
          <button className="small" onClick={addBookmark} title="Закладка на текущем предложении">🔖</button>
          <button className="small" onClick={() => changeScale(-0.05)} title="Мельче (клавиша −)">A−</button>
          <button className="small" onClick={() => changeScale(0.05)} title="Крупнее (клавиша +)">A+</button>
          <button className={`small${immersive ? ' active' : ''}`} onClick={toggleImmersive} title="Режим погружения: только текст (клавиша F)">❦ Погружение</button>
          <button className="small" onClick={readAloudHere} title="Испытание чтеца: читать абзац вслух (клавиша R)">🎙 Читать вслух</button>
          <span className={`audiobook${ab.active ? ' on' : ''}`}>
            <button className={`small${ab.playing ? ' active' : ''}`} onClick={toggleAudiobook} title="Аудиокнига: читать главу вслух (клавиша A)">
              {ab.playing ? '⏸' : '🎧'}{ab.active ? '' : ' Аудиокнига'}
            </button>
            {ab.active && (
              <>
                <button className="small" onClick={() => seekAudiobook(-1)} title="Предыдущее предложение (Shift+↑)">⏮</button>
                <button className="small" onClick={() => seekAudiobook(1)} title="Следующее предложение (Shift+↓)">⏭</button>
                <button className="small" onClick={stopAudiobook} title="Остановить аудиокнигу">⏹</button>
                <span className="muted small">№{ab.index + 1}</span>
              </>
            )}
          </span>
          <button className="small hint-toggle" onClick={cycleHintMode} title="Режим подсказок над словами (клавиша H)">{HINT_MODE_LABELS[hintMode]}</button>
          <select className="small ru-select" value={ruMode} onChange={(e) => setRuMode(e.target.value)} title="Колонка перевода (клавиша T — показать/скрыть)">
            {RU_MODES.map((m) => <option key={m} value={m}>{RU_MODE_LABELS[m]}</option>)}
          </select>
        </div>
      </div>

      {tocOpen && (
        <div className="toc-backdrop" onClick={() => setTocOpen(false)}>
          <aside className="toc" onClick={(e) => e.stopPropagation()}>
            <h2>Оглавление</h2>
            <ol className="toc-list">
              {book.chapters.map((c) => (
                <li key={c.idx} className={c.idx === chapterIdx ? 'current' : ''} style={{ paddingLeft: `${c.level * 0.9}rem` }}>
                  <button className="link" onClick={() => openChapter(c.idx, 0)}>{c.title}</button>
                  <span className={`chip${c.translated === c.total ? ' ok' : ''}`} title="Переведено">{c.translated}/{c.total}</span>
                </li>
              ))}
            </ol>
            <h2>Закладки</h2>
            {bookmarks.length === 0 ? <p className="muted small">Закладок нет. Кнопка 🔖 ставит закладку на текущем предложении.</p> : (
              <ul className="bm-list">
                {bookmarks.map((b) => (
                  <li key={b.id}>
                    <button className="link" onClick={() => openChapter(b.chapter, b.sentence)}>
                      <span className="muted">{b.chapterTitle} · №{b.sentence + 1}</span> {b.text?.slice(0, 80)}
                    </button>
                    <button className="icon danger" onClick={() => removeBookmark(b.id)} title="Удалить закладку">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {!chapter ? <p className="muted">Загрузка главы…</p> : (
        <div className="rows" lang={book.lang}>
          {/* Заглавие: название книги и виньетка; сам заголовок главы — первые строки текста. */}
          {immersive && (
            <div className="immersive-dock">
              <button className="small" onClick={() => setTocOpen(true)} title="Оглавление и закладки">☰</button>
              <button className={`small${ab.playing ? ' active' : ''}`} onClick={toggleAudiobook} title="Аудиокнига (клавиша A)">{ab.playing ? '⏸' : '🎧'}</button>
              <button className="small" onClick={toggleImmersive} title="Выйти из режима погружения (F или Esc)">❦ выйти</button>
            </div>
          )}
          <header className="chapter-head">
            <div className="ch-num">{book.title}</div>
            <div className="ornament">❦</div>
          </header>
          {rows.map((s, i) => (
            <Row
              key={s.id}
              s={s}
              isNewPara={i > 0 && s.para !== rows[i - 1].para}
              paraStart={i === 0 || s.para !== rows[i - 1].para}
              hintMode={hintMode}
              ruMode={ruMode}
              ruOpen={ruOpen.has(s.idx)}
              tappedTok={tapped && tapped.startsWith(`s${s.idx}t`) ? tapped : null}
              keys={keys}
              speaking={speakingId === `sent-${s.id}`}
              onTap={setTapped}
              onToggleRu={toggleRu}
              onOpenToken={onOpenToken}
              onPlay={onPlay}
              onRetry={onRetry}
              onReadAloud={openReadAloud}
            />
          ))}
          {card && (
            <WordCard token={card.token} sentence={card.sentence} book={book} chapter={chapter} onClose={() => setCard(null)} />
          )}
          <SelectionPopover book={book} chapter={chapter} getSentence={getSentence} />
          {readAloud !== null && (() => {
            const list = paragraphs();
            const at = list.indexOf(readAloud);
            return (
              <ReadAloud
                key={readAloud}
                book={book}
                chapter={chapter}
                para={readAloud}
                hasNext={at >= 0 && at < list.length - 1}
                onNext={() => {
                  const next = list[at + 1];
                  setReadAloud(next);
                  const first = chapter.sentences.find((x) => x.para === next);
                  if (first) document.querySelector(`.rows [data-index="${first.idx}"]`)?.scrollIntoView({ block: 'center' });
                }}
                onClose={() => setReadAloud(null)}
              />
            );
          })()}
          <div className="chapter-end">
            <div className="ornament">✦ ❦ ✦</div>
            {chapterIdx < book.chapters.length - 1 ? (
              <button className="primary" onClick={() => goChapter(1)}>Следующая глава: {book.chapters[chapterIdx + 1].title} ›</button>
            ) : <span className="muted">Конец книги</span>}
          </div>
        </div>
      )}
    </div>
  );
}
