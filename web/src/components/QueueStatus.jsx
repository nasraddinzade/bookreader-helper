// Состояние фоновой очереди перевода: что делается, скорость, оценка оставшегося времени, пауза.

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useServerEvents } from '../lib/events.js';

export function formatEta(min) {
  if (min == null) return '';
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `≈ ${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `≈ ${h} ч${m ? ` ${m} мин` : ''}`;
}

const fmtTime = (ms) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (ms) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function QueueStatus({ bookId, compact = false }) {
  const [q, setQ] = useState(null);
  const timer = useRef(null);
  const load = () => api.get('/api/queue').then(setQ).catch(() => {});
  useEffect(() => { load(); }, []);
  useServerEvents((ev) => {
    if (!['queue', 'sentence', 'settings'].includes(ev.type)) return;
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; load(); }, ev.type === 'queue' ? 100 : 2500);
  });
  if (!q) return null;

  const mine = bookId ? q.books.find((b) => b.id === bookId) : null;
  const pending = bookId ? mine?.pending || 0 : q.books.reduce((a, b) => a + b.pending, 0);
  const toggle = () => api.post(q.paused ? '/api/queue/resume' : '/api/queue/pause').then(setQ);

  let text = '';
  let cls = '';
  if (q.status === 'limited') { text = `Лимит подписки Claude — продолжу${q.resumeAt ? ` в ${fmtTime(q.resumeAt)}` : ' позже'}`; cls = 'warn'; }
  else if (q.status === 'auth') { text = q.message; cls = 'warn'; }
  else if (q.status === 'error') { text = q.message; cls = 'warn'; }
  else if (q.paused) text = pending ? `Перевод на паузе (осталось ${pending})` : 'Перевод на паузе';
  else if (!pending) text = bookId ? 'Книга переведена' : 'Очередь пуста';
  else if (q.status === 'running') {
    const eta = formatEta(bookId ? mine?.etaMin : q.books[q.books.length - 1]?.etaMin);
    text = `Переводится: осталось ${pending}${q.perMinute ? ` · ${q.perMinute}/мин` : ''}${eta ? ` · ${eta}` : ''}`;
  } else text = `В очереди ${pending}`;

  // Расход подписки: CLI сообщает его в каждом ответе. Показываем, когда он заметный.
  const u = q.usage;
  const usageText = u?.utilization != null && (u.utilization >= 0.5 || /warning|rejected/.test(u.status))
    ? `Подписка: ${u.type === 'seven_day' ? 'недельный' : u.type === 'five_hour' ? '5-часовой' : ''} лимит ${Math.round(u.utilization * 100)} %`
      + (u.resetsAt ? `, сброс ${fmtDateTime(u.resetsAt)}` : '')
    : '';

  return (
    <span className={`queue-status ${cls}`} title={[q.message || text, usageText].filter(Boolean).join('\n')}>
      <span className="qs-text">{compact && text.length > 90 ? text.slice(0, 88) + '…' : text}</span>
      {usageText && !compact && <span className={`qs-usage${u.utilization >= 0.8 ? ' warn' : ''}`}>{usageText}</span>}
      {(pending > 0 || q.paused) && (
        <button className="small" onClick={toggle} title={q.paused ? 'Продолжить перевод' : 'Поставить перевод на паузу'}>
          {q.paused ? '▶ Продолжить' : '⏸ Пауза'}
        </button>
      )}
    </span>
  );
}
