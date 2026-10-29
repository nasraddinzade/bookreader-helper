import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/route.js';
import { useServerEvents } from '../lib/events.js';
import { useSettings, updateSettings, getSettings, HINT_MODES, HINT_MODE_LABELS, RU_MODES, RU_MODE_LABELS } from '../lib/settings.js';

function Token({ t, id, hintMode, tapped, onTap, onOpen }) {
  const ptype = useRef('mouse');
  const cls = ['tok', tapped && 'tapped'].filter(Boolean).join(' ');
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
      <span className="g">{t.ctx || ' '}</span>
      <span className="w">{t.en}</span>
      {hintMode === 'hover' && t.ctx ? <span className="tip">{t.ctx}</span> : null}
    </span>
  );
}

const Row = memo(function Row({ s, isNewPara, hintMode, ruMode, ruOpen, tappedTok, onTap, onToggleRu, onOpenToken }) {
  const sid = `s${s.idx}`;
  const done = s.status === 'done' && s.gloss;
  const showRuInline = ruMode === 'click' && ruOpen;
  return (
    <div
      data-index={s.idx}
      className={['row', isNewPara && 'para', s.kind === 'h' && 'heading', s.status].filter(Boolean).join(' ')}
    >
      <button
        className={`num${ruMode === 'click' ? ' clickable' : ''}${ruOpen ? ' open' : ''}`}
        title={ruMode === 'click' ? 'Показать перевод предложения' : `Предложение ${s.idx + 1}`}
        onClick={() => ruMode === 'click' && onToggleRu(s.idx)}
        tabIndex={ruMode === 'click' ? 0 : -1}
      >
        {s.idx + 1}
      </button>
      <span className="play-slot" />
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
                onTap={onTap}
                onOpen={() => onOpenToken?.(s, t, k)}
              />
            </span>
          ))
        ) : (
          <span className="plain">{s.text}</span>
        )}
        {showRuInline && (
          <div className="ru-inline">{done ? s.gloss.full : <span className="muted">ещё не переведено</span>}</div>
        )}
      </div>
      {ruMode === 'show' && (
        <div className="ru">
          {done ? (s.gloss.full || <span className="muted">—</span>)
            : s.status === 'error' ? <span className="err" title={s.error || ''}>ошибка перевода</span>
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
  const [book, setBook] = useState(null);
  const [error, setError] = useState('');
  const [chapterIdx, setChapterIdx] = useState(null);
  const [chapter, setChapter] = useState(null);
  const [tapped, setTapped] = useState(null);
  const [ruOpen, setRuOpen] = useState(() => new Set());
  const [tocOpen, setTocOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
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
    if (ev.bookId !== bookId) return;
    if ((ev.type === 'sentence' || ev.type === 'audio') && ev.chapter === chapterIdx) {
      if (!refetchTimer.current) {
        refetchTimer.current = setTimeout(() => { refetchTimer.current = null; loadChapter(chapterIdx).catch(() => {}); }, 800);
      }
    }
    if (ev.type === 'chapter-done' || ev.type === 'queue') loadBook();
  });

  // Горячие клавиши: H — подсказки, T — колонка перевода, ←/→ с Alt — главы.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'h' || k === 'р') { e.preventDefault(); cycleHintMode(); }
      else if (k === 't' || k === 'е') { e.preventDefault(); toggleRuColumn(); }
      else if (e.key === 'Escape') { setTapped(null); setTocOpen(false); }
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
    <div className={`reader mode-${hintMode} ru-${ruMode}`}>
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
        </div>
        <div className="reader-tools">
          <button className="small" onClick={() => goChapter(-1)} disabled={!chapterIdx} title="Предыдущая глава (Alt+←)">‹</button>
          <button className="small" onClick={() => goChapter(1)} disabled={chapterIdx >= book.chapters.length - 1} title="Следующая глава (Alt+→)">›</button>
          <button className="small" onClick={addBookmark} title="Закладка на текущем предложении">🔖</button>
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
          {rows.map((s, i) => (
            <Row
              key={s.id}
              s={s}
              isNewPara={i > 0 && s.para !== rows[i - 1].para}
              hintMode={hintMode}
              ruMode={ruMode}
              ruOpen={ruOpen.has(s.idx)}
              tappedTok={tapped && tapped.startsWith(`s${s.idx}t`) ? tapped : null}
              onTap={setTapped}
              onToggleRu={toggleRu}
            />
          ))}
          <div className="chapter-end">
            {chapterIdx < book.chapters.length - 1 ? (
              <button className="primary" onClick={() => goChapter(1)}>Следующая глава: {book.chapters[chapterIdx + 1].title} ›</button>
            ) : <span className="muted">Конец книги</span>}
          </div>
        </div>
      )}
    </div>
  );
}
