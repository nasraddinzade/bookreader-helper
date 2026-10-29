import { useEffect, useRef, useState } from 'react';
import { api, uploadFile } from '../lib/api.js';
import { useServerEvents } from '../lib/events.js';
import QueueStatus, { formatEta } from './QueueStatus.jsx';

function Bar({ value, max, label, cls = '' }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div className={`pbar ${cls}`} title={`${label}: ${value} из ${max} (${pct}%)`}>
      <span className="pbar-label">{label}</span>
      <span className="pbar-track"><span className="pbar-fill" style={{ width: `${pct}%` }} /></span>
      <span className="pbar-pct">{pct}%</span>
    </div>
  );
}

export default function Library() {
  const [books, setBooks] = useState(null);
  const [error, setError] = useState('');
  const [upload, setUpload] = useState(null); // { name, progress, phase }
  const fileRef = useRef(null);
  const reloadTimer = useRef(null);

  const [queue, setQueue] = useState(null);
  const reload = () => {
    api.get('/api/queue').then(setQueue).catch(() => {});
    return api.get('/api/books').then(setBooks).catch((e) => setError(e.message));
  };
  useEffect(() => { reload(); }, []);

  // Прогресс перевода и озвучки приходит событиями; список перечитываем не чаще раза в 2 с.
  useServerEvents((ev) => {
    if (!['library', 'sentence', 'audio', 'queue'].includes(ev.type)) return;
    if (reloadTimer.current) return;
    reloadTimer.current = setTimeout(() => { reloadTimer.current = null; reload(); }, ev.type === 'library' ? 0 : 2000);
  });

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setUpload({ name: file.name, progress: 0, phase: 'Загрузка' });
    try {
      await uploadFile('/api/books', file, (p) => setUpload((u) => u && { ...u, progress: p, phase: p >= 1 ? 'Разбор книги' : 'Загрузка' }));
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpload(null);
    }
  };

  const remove = async (b) => {
    if (!window.confirm(`Удалить книгу «${b.title}» вместе с переводом и аудио? Сохранённые слова и фразы останутся.`)) return;
    await api.del(`/api/books/${b.id}`);
    reload();
  };

  const togglePause = async (b) => {
    await api.post(`/api/books/${b.id}/${b.paused ? 'resume' : 'pause'}`);
    reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Библиотека</h1>
        <button className="primary" onClick={() => fileRef.current?.click()} disabled={!!upload}>Добавить книгу</button>
        <input ref={fileRef} type="file" accept=".epub,.fb2,.zip,.txt" hidden onChange={onFile} />
      </div>
      <p className="muted small">EPUB, FB2 или TXT. Книга переводится в фоне, читать можно с первых переведённых глав.</p>
      <p className="lib-queue"><QueueStatus /></p>
      {upload && (
        <p className="notice">{upload.phase}: {upload.name} {upload.phase === 'Загрузка' ? `${Math.round(upload.progress * 100)}%` : '…'}</p>
      )}
      {error && <p className="notice warn">{error}</p>}
      {books === null ? (
        <p className="muted">Загрузка…</p>
      ) : books.length === 0 ? (
        <p className="muted">Книг пока нет. Нажмите «Добавить книгу».</p>
      ) : (
        <ul className="books">
          {books.map((b) => (
            <li key={b.id} className="book">
              <a className="book-cover" href={`#/read/${b.id}`}>
                {b.hasCover ? <img src={`/api/books/${b.id}/cover`} alt="" loading="lazy" /> : <span className="cover-ph">{b.title}</span>}
              </a>
              <div className="book-info">
                <a className="book-title" href={`#/read/${b.id}`}>{b.title}</a>
                {b.author && <div className="muted small">{b.author}</div>}
                <div className="muted small">{b.lang} → {b.targetLang} · {b.total} предл.</div>
                <Bar label="Перевод" value={b.translated} max={b.total} />
                <Bar label="Озвучка" value={b.voiced} max={b.total} cls="audio" />
                <Bar label="Прочитано" value={b.readPercent} max={100} cls="read" />
                {b.errors > 0 && (
                  <div className="error small">
                    Ошибок перевода: {b.errors}{' '}
                    <button className="link small" onClick={() => api.post(`/api/books/${b.id}/retry-errors`).then(reload)}>повторить</button>
                  </div>
                )}
                {(() => {
                  const q = queue?.books?.find((x) => x.id === b.id);
                  return q?.etaMin != null && !b.paused ? <div className="muted small">До конца перевода: {formatEta(q.etaMin)}</div> : null;
                })()}
                <div className="book-actions">
                  <a href={`#/read/${b.id}`}>Читать</a>
                  {b.translated < b.total && (
                    <button className="small" onClick={() => togglePause(b)}>{b.paused ? 'Продолжить перевод' : 'Пауза'}</button>
                  )}
                  <button className="small danger" onClick={() => remove(b)}>Удалить</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
