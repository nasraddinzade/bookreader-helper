// Разделы «Слова» и «Фразы»: поиск, фильтр по книге, сортировка, озвучка, переход к месту в книге,
// удаление, экспорт в JSON.

import { useEffect, useMemo, useState } from 'react';
import { vocabApi } from '../lib/vocab.js';
import { useServerEvents } from '../lib/events.js';
import { speakText, useSpeakingId } from '../lib/tts.js';

/** Предложение с выделенным словом/фразой. */
export function Highlighted({ sentence, part }) {
  const p = String(part || '').trim();
  const at = p ? sentence.toLowerCase().indexOf(p.toLowerCase()) : -1;
  if (at < 0) return <span>{sentence}</span>;
  return <span>{sentence.slice(0, at)}<mark>{sentence.slice(at, at + p.length)}</mark>{sentence.slice(at + p.length)}</span>;
}

export const placeHref = (e) => `#/read/${e.bookId}/${e.chapter ?? 0}/${e.sentenceIdx ?? 0}`;

export default function Vocab({ kind }) {
  const isWord = kind === 'word';
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [book, setBook] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [open, setOpen] = useState({});
  const speakingId = useSpeakingId();

  const load = () => vocabApi.list(kind).then(setItems).catch(() => setItems([]));
  useEffect(() => { setItems(null); load(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  useServerEvents((ev) => { if (ev.type === 'vocab') load(); });

  const books = useMemo(() => {
    const m = new Map();
    for (const it of items || []) for (const e of it.examples) if (e.bookTitle) m.set(e.bookTitle, true);
    return [...m.keys()].sort();
  }, [items]);

  const shown = useMemo(() => {
    if (!items) return [];
    const needle = q.trim().toLowerCase();
    const list = items.filter((it) => {
      if (book && !it.examples.some((e) => e.bookTitle === book)) return false;
      if (needle) {
        const hay = [it.text, it.lemma, it.ctx, it.base, ...it.examples.map((e) => e.sentence)].join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const name = (it) => (isWord ? it.lemma || it.text : it.text).toLowerCase();
    switch (sort) {
      case 'date-asc': list.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id - b.id); break;
      case 'alpha': list.sort((a, b) => name(a).localeCompare(name(b), 'en')); break;
      case 'alpha-desc': list.sort((a, b) => name(b).localeCompare(name(a), 'en')); break;
      default: list.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.id - a.id);
    }
    return list;
  }, [items, q, book, sort, isWord]);

  const remove = async (it) => {
    if (!window.confirm(`Удалить «${it.text}» вместе с примерами?`)) return;
    await vocabApi.remove(it.id);
    load();
  };
  const removeExample = async (it, e) => {
    if (it.examples.length === 1) return remove(it);
    await vocabApi.removeExample(it.id, e.id);
    load();
  };

  const title = isWord ? 'Слова' : 'Фразы и выражения';
  const learned = (items || []).filter((w) => w.learned).length;

  return (
    <div className="page vocab">
      <div className="page-head">
        <h1>{title} <span className="muted h-sub">{items ? `${items.length}, выучено ${learned}` : ''}</span></h1>
        <a className="btn" href={`#/review/${isWord ? 'words' : 'phrases'}`}>Повторять</a>
        <a className="btn" href={`/api/vocab/export?kind=${kind}`} download>Экспорт в JSON</a>
      </div>
      <div className="filters">
        <input placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={book} onChange={(e) => setBook(e.target.value)}>
          <option value="">Все книги</option>
          {books.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="date-desc">Сначала новые</option>
          <option value="date-asc">Сначала старые</option>
          <option value="alpha">По алфавиту A–Z</option>
          <option value="alpha-desc">По алфавиту Z–A</option>
        </select>
      </div>
      {items === null ? <p className="muted">Загрузка…</p>
        : items.length === 0 ? (
          <p className="muted">
            {isWord ? 'Пока пусто. Нажмите на слово в книге и выберите «Запомнить».'
              : 'Пока пусто. Выделите в книге несколько слов и нажмите «Запомнить» во всплывающем переводе.'}
          </p>
        ) : shown.length === 0 ? <p className="muted">Ничего не найдено.</p> : (
          <ul className="list words">
            {shown.map((it) => {
              const examples = open[it.id] ? it.examples : it.examples.slice(0, 1);
              return (
                <li key={it.id} className={`list-item word${it.learned ? ' learned' : ''}`}>
                  <div className="list-main">
                    <div className="word-head">
                      <span className="word-en" lang={it.lang}>{it.text}</span>
                      <button className={`icon${speakingId === `v${it.id}` ? ' active' : ''}`} title="Прослушать" onClick={() => speakText(it.text, { id: `v${it.id}`, lang: it.lang })}>🔊</button>
                      {isWord && it.lemma && it.lemma.toLowerCase() !== it.text.toLowerCase() && <span className="muted">→ {it.lemma}</span>}
                      {isWord && it.pos && <span className="chip">{it.pos}</span>}
                      {it.learned ? <span className="chip ok">выучено</span>
                        : it.cleanHitDays.length ? <span className="chip">{it.cleanHitDays.length}/{it.requiredDays}</span> : null}
                      <span className="muted small">{it.addedAt}</span>
                    </div>
                    <div className="word-base">
                      {isWord ? <>{it.base || it.ctx}{it.ctx && it.ctx !== it.base ? <span className="muted"> · в контексте: {it.ctx}</span> : null}</>
                        : it.ctx}
                    </div>
                    <ul className="examples">
                      {examples.map((e) => (
                        <li key={e.id}>
                          <button className={`icon${speakingId === `e${e.id}` ? ' active' : ''}`} title="Прослушать пример" onClick={() => speakText(e.sentence, { id: `e${e.id}`, lang: it.lang })}>🔊</button>
                          <div className="ex-body">
                            <div><Highlighted sentence={e.sentence} part={e.en} /></div>
                            {e.sentenceRu && <div className="muted">{e.sentenceRu}</div>}
                            <div className="ex-src small">
                              {e.bookExists ? <a href={placeHref(e)}>{e.bookTitle}{e.chapterTitle ? ` · ${e.chapterTitle}` : ''} — к месту в книге</a>
                                : <span className="muted">{e.bookTitle} (книга удалена)</span>}
                              <button className="link small danger" onClick={() => removeExample(it, e)} title="Удалить пример">удалить пример</button>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                    {it.examples.length > 1 && (
                      <button className="small link" onClick={() => setOpen((o) => ({ ...o, [it.id]: !o[it.id] }))}>
                        {open[it.id] ? 'скрыть примеры' : `ещё примеров: ${it.examples.length - 1}`}
                      </button>
                    )}
                  </div>
                  <button className="icon danger" title="Удалить" onClick={() => remove(it)}>✕</button>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
