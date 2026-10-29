// Повторение карточками: слово или фраза и предложение-источник с закрытым переводом,
// «Показать», затем «Знал» / «Не знал». Выучено после верных ответов в 3 разных дня;
// несколько ответов за день — один; «Не знал» обнуляет серию и возвращает карточку чаще.

import { useEffect, useMemo, useState } from 'react';
import { vocabApi } from '../lib/vocab.js';
import { speakText, useSpeakingId } from '../lib/tts.js';
import { Highlighted, placeHref } from './Vocab.jsx';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Очередь: невыученные. Сначала недавно забытые и с меньшей серией; засчитанные сегодня — в конец.
function buildQueue(items) {
  const d = today();
  const hitToday = (w) => w.cleanHitDays.includes(d);
  return items.filter((w) => !w.learned).sort((a, b) => {
    const ha = hitToday(a) ? 1 : 0, hb = hitToday(b) ? 1 : 0;
    if (ha !== hb) return ha - hb;
    const ma = a.lastMissAt || '', mb = b.lastMissAt || '';
    if (ma !== mb) return mb.localeCompare(ma);
    if (a.cleanHitDays.length !== b.cleanHitDays.length) return a.cleanHitDays.length - b.cleanHitDays.length;
    return a.addedAt.localeCompare(b.addedAt);
  });
}

const MODES = [['words', 'Слова', 'word'], ['phrases', 'Фразы', 'phrase'], ['all', 'Всё вместе', '']];

export default function Review({ mode = 'all' }) {
  const kind = (MODES.find((m) => m[0] === mode) || MODES[2])[2];
  const [all, setAll] = useState(null);
  const [queue, setQueue] = useState([]);
  const [revealed, setRevealed] = useState(false);
  const [stats, setStats] = useState({ knew: 0, missed: 0, learnedNow: 0 });
  const speakingId = useSpeakingId();

  const start = () => vocabApi.list(kind).then((items) => {
    setAll(items);
    setQueue(buildQueue(items));
    setRevealed(false);
    setStats({ knew: 0, missed: 0, learnedNow: 0 });
  });
  useEffect(() => { setAll(null); start(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = queue[0];
  // Пример — случайный из сохранённых, чтобы слово не запоминалось по одному предложению.
  const example = useMemo(() => {
    const ex = current?.examples || [];
    return ex.length ? ex[Math.floor(Math.random() * ex.length)] : null;
  }, [current]);

  const answer = async (knew) => {
    if (!current) return;
    const updated = await vocabApi.answer(current.id, knew);
    setStats((s) => ({
      knew: s.knew + (knew ? 1 : 0),
      missed: s.missed + (knew ? 0 : 1),
      learnedNow: s.learnedNow + (updated.learned && !current.learned ? 1 : 0),
    }));
    setQueue((q) => {
      const rest = q.slice(1);
      if (knew) return rest;
      // «Не знал» — карточка возвращается через 2–3 карточки.
      const at = Math.min(rest.length, 2 + Math.floor(Math.random() * 2));
      return [...rest.slice(0, at), updated, ...rest.slice(at)];
    });
    setRevealed(false);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (!current || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
      if (e.key === ' ' || e.key === 'Enter') { if (!revealed) { e.preventDefault(); setRevealed(true); } }
      else if (revealed && (e.key === '1' || e.key === 'ArrowLeft')) answer(false);
      else if (revealed && (e.key === '2' || e.key === 'ArrowRight')) answer(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tabs = (
    <div className="tabs">
      {MODES.map(([id, label]) => <a key={id} href={`#/review/${id}`} className={id === mode ? 'active' : ''}>{label}</a>)}
    </div>
  );

  if (all === null) return <div className="page narrow"><h1>Повторение</h1>{tabs}<p className="muted">Загрузка…</p></div>;
  const total = all.length;
  const learned = all.filter((w) => w.learned).length;

  if (!current) {
    return (
      <div className="page narrow">
        <h1>Повторение</h1>
        {tabs}
        {total === 0 ? <p className="muted">Здесь пока нечего повторять: сохраните слова или фразы из книги.</p>
          : stats.knew + stats.missed > 0 ? (
            <div className="summary">
              <p>Сессия закончена.</p>
              <p>Знал: {stats.knew} · Не знал: {stats.missed} · Выучено сейчас: {stats.learnedNow}</p>
              <p className="muted">Всего выучено {learned} из {total}. Карточка считается выученной после верных ответов в 3 разных дня.</p>
              <button className="primary" onClick={start}>Ещё раз</button>
            </div>
          ) : <p className="muted">Все {total} выучены. Повторять нечего.</p>}
      </div>
    );
  }

  const isPhrase = current.kind === 'phrase';
  return (
    <div className="page narrow review">
      <h1>Повторение</h1>
      {tabs}
      <div className="muted small">осталось {queue.length} · знал {stats.knew} · не знал {stats.missed}</div>
      <div className="flashcard">
        <div className="fc-kind muted small">{isPhrase ? 'фраза' : 'слово'}</div>
        <div className="fc-word">
          <span lang={current.lang}>{current.text}</span>
          <button className={`icon${speakingId === 'fc-w' ? ' active' : ''}`} title="Прослушать" onClick={() => speakText(current.text, { id: 'fc-w', lang: current.lang })}>🔊</button>
        </div>
        {example && (
          <div className="fc-sentence">
            <button className={`icon${speakingId === 'fc-s' ? ' active' : ''}`} title="Прослушать пример" onClick={() => speakText(example.sentence, { id: 'fc-s', lang: current.lang })}>🔊</button>
            <Highlighted sentence={example.sentence} part={example.en} />
          </div>
        )}
        {!revealed ? (
          <div className="fc-hidden">
            <button className="primary big" onClick={() => setRevealed(true)}>Показать</button>
            <div className="muted small">Пробел или Enter</div>
          </div>
        ) : (
          <div className="fc-answer">
            <dl className="card-grid">
              {isPhrase ? <><dt>Перевод</dt><dd>{current.ctx || '—'}</dd></> : (
                <>
                  <dt>В контексте</dt><dd>{(example?.ctx || current.ctx) || '—'}</dd>
                  <dt>Начальная форма</dt><dd>{current.lemma} {current.pos && <span className="chip">{current.pos}</span>}</dd>
                  <dt>Словарь</dt><dd>{current.base || '—'}</dd>
                </>
              )}
              <dt>Предложение</dt><dd>{example?.sentenceRu || <span className="muted">—</span>}</dd>
            </dl>
            {example?.bookExists && <div className="small"><a href={placeHref(example)}>{example.bookTitle} — к месту в книге</a></div>}
            <div className="fc-buttons">
              <button className="danger big" onClick={() => answer(false)}>Не знал <span className="kbd">1</span></button>
              <button className="ok big" onClick={() => answer(true)}>Знал <span className="kbd">2</span></button>
            </div>
            <div className="muted small">
              Серия: {current.cleanHitDays.length} из {current.requiredDays} дней
              {current.cleanHitDays.includes(today()) ? ' · сегодня уже засчитано' : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
