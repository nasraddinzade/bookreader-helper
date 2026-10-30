// «Испытание чтеца»: абзац читается вслух, прочитанные слова проявляются чернилами, за слова
// начисляются очки с комбо-множителем. Неверно прочитанное слово останавливает игру: звучит
// правильное произношение, слово нужно повторить. В конце — звёзды, опыт и викторина по словам абзаца.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { speakText, stopSpeaking } from '../lib/tts.js';
import { cleanCtx } from '../lib/vocab.js';
import { useSettings } from '../lib/settings.js';
import { ReadTracker, paragraphWords, sameWord, comboMultiplier, levelInfo } from '../../../shared/read-align.js';

const THRESHOLDS = { soft: 0.8, normal: 0.9, strict: 0.97 };

// Отладка без микрофона: window.__fakeMic = async (kind, text) => ArrayBuffer с записью
// (kind — 'main' для абзаца, 'repeat' для повтора слова). Без неё — настоящий микрофон.
const fakeMic = async (kind, text) => (typeof window.__fakeMic === 'function' ? window.__fakeMic(kind, text) : undefined);
const FINAL_DELAY_MS = 350; // ждём «свободный» распознаватель, чтобы сверить отрезок по времени

function useSpeech() {
  const ref = useRef(null);
  if (!ref.current) ref.current = import('../lib/speech.js');
  return ref.current;
}

export default function ReadAloud({ book, chapter, para, onClose, onNext, hasNext }) {
  const settings = useSettings();
  const speechP = useSpeech();
  const sentences = useMemo(() => chapter.sentences.filter((s) => s.para === para), [chapter, para]);
  const tokensOf = (s) => (s.gloss?.tokens?.length ? s.gloss.tokens : s.text.split(/\s+/).filter(Boolean).map((en, i) => ({ en, gap: i ? ' ' : '' })));

  const [phase, setPhase] = useState('loading'); // loading | ready | listening | mistake | result | quiz | end
  const [error, setError] = useState('');
  const [, setTick] = useState(0);
  const rerender = () => setTick((t) => t + 1);
  const [tentative, setTentative] = useState(0);
  const [level, setLevel] = useState(0);
  const [pops, setPops] = useState([]); // всплывающие «+10»
  const [mistake, setMistake] = useState(null); // { i, heard, tries, status }
  const [result, setResult] = useState(null); // итог абзаца
  const [game, setGame] = useState(null); // уровень и опыт после абзаца
  const [questions, setQuestions] = useState(null);
  const [qIndex, setQIndex] = useState(0);
  const [qState, setQState] = useState({ tries: 0, picked: null, done: false });
  const [quizPoints, setQuizPoints] = useState(0);

  const tracker = useRef(null);
  const inMistake = useRef(false);
  const listen = useRef(null);
  const finalTimer = useRef(null);
  const words = tracker.current?.words || [];

  // Подготовка: слова абзаца, какие из них знает распознаватель, загрузка модели.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const w = paragraphWords(sentences.map((s) => ({ id: s.id, text: s.text, tokens: tokensOf(s) })));
        const info = await api.post('/api/speech/words', { words: [...new Set(w.map((x) => x.w))] });
        const inVocab = new Map(info.map((x) => [x.word, x.inVocab]));
        for (const x of w) if (inVocab.get(x.w) === false) x.check = false;
        tracker.current = new ReadTracker(w, { threshold: THRESHOLDS[settings.readStrictness] || THRESHOLDS.normal });
        tracker.current.skipUnchecked();
        window.__raTracker = tracker.current; // для отладки из консоли
        const sp = await speechP;
        await sp.loadSpeechModel();
        if (alive) setPhase('ready');
      } catch (e) {
        if (alive) setError('Не удалось подготовить распознавание: ' + e.message);
      }
    })();
    return () => { alive = false; stopAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopAll() {
    clearTimeout(finalTimer.current);
    listen.current?.stop();
    listen.current = null;
    stopSpeaking();
  }

  // Произношение слова; если браузер не дал воспроизвести звук, игра не должна зависнуть.
  const sayWord = (w) => Promise.race([speakText(w, { id: 'ra-word', lang: book.lang }), new Promise((r) => setTimeout(r, 4000))]);

  const grammarMain = () => [...new Set(tracker.current.words.filter((x) => x.check).map((x) => x.w)), '[unk]'];

  function popAt(i, text) {
    const id = Math.random();
    setPops((p) => [...p, { id, i, text }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 950);
  }

  function applyEvents(events) {
    const tr = tracker.current;
    for (const ev of events) {
      if (ev.type === 'ok') popAt(ev.i, `+${Math.round(10 * comboMultiplier(Math.max(0, tr.combo - 1)))}`);
      if (ev.type === 'error') { onMistake(ev.i, ev.heard); return; }
    }
    setTentative(tr.pos);
    rerender();
    if (tr.done) finish();
  }

  async function startMain() {
    setError('');
    setPhase('listening');
    const sp = await speechP;
    const tr = tracker.current;
    let pendingFinal = null;
    try {
      listen.current = await sp.startListening({
        audio: await fakeMic('main', tr.words.slice(tr.pos).map((w) => w.w).join(' ')),
        onLevel: setLevel,
        recognizers: [
          {
            grammar: grammarMain(),
            onPartial: (text) => {
              const p = tr.partial(text);
              setTentative(p.upTo);
              // [unk] на ожидаемом слове, а чтение уже ушло дальше — ошибка, не ждём паузы.
              if (p.unk && !tr.paused) onMistake(p.upTo, '');
            },
            onFinal: (r) => {
              pendingFinal = r.result || [];
              clearTimeout(finalTimer.current);
              finalTimer.current = setTimeout(() => { const res = pendingFinal; pendingFinal = null; applyEvents(tr.final(res)); }, FINAL_DELAY_MS);
            },
          },
          { grammar: null, onFinal: (r) => tr.addFree(r.result) },
        ],
      });
    } catch (e) {
      setPhase('ready');
      setError(e.name === 'NotAllowedError' ? 'Нет доступа к микрофону: разрешите его для этой страницы в настройках браузера.' : 'Микрофон недоступен: ' + e.message);
    }
  }

  async function onMistake(i, heard) {
    const tr = tracker.current;
    // Ошибка может прийти дважды (по промежуточной гипотезе и по итогу) — обрабатываем один раз.
    if (inMistake.current) return;
    inMistake.current = true;
    if (tr.state[i] !== 'error') tr.error(i, heard);
    clearTimeout(finalTimer.current);
    listen.current?.stop();
    listen.current = null;
    setMistake({ i, heard, tries: 0, status: 'listen' });
    setPhase('mistake');
    rerender();
    await sayWord(tr.words[i].w);
    listenRepeat(i, 0);
  }

  async function listenRepeat(i, tries) {
    const sp = await speechP;
    const tr = tracker.current;
    const target = tr.words[i].w;
    const free = [];
    setMistake((m) => m && { ...m, tries, status: 'listening' });
    let handled = false;
    listen.current = await sp.startListening({
      audio: await fakeMic('repeat', target),
      onLevel: setLevel,
      recognizers: [
        {
          grammar: [target, '[unk]'],
          onFinal: (r) => {
            setTimeout(() => {
              if (handled) return;
              const got = (r.result || []).find((w) => w.word !== '[unk]');
              if (!got && !(r.result || []).length) return; // тишина
              handled = true;
              listen.current?.stop();
              listen.current = null;
              const ok = got && (got.conf >= 0.85 || free.some((x) => sameWord(x.word, target)));
              if (ok) {
                tr.fixed(i);
                popAt(i, '+5');
                resumeAfterMistake();
              } else {
                const next = tries + 1;
                setMistake((m) => m && { ...m, tries: next, status: next >= 3 ? 'give-up' : 'again', heard: free.map((x) => x.word).join(' ') });
                if (next < 3) sayWord(target).then(() => listenRepeat(i, next));
              }
            }, FINAL_DELAY_MS);
          },
        },
        { grammar: null, onFinal: (r) => free.push(...(r.result || [])) },
      ],
    });
  }

  function resumeAfterMistake() {
    listen.current?.stop();
    listen.current = null;
    inMistake.current = false;
    setMistake(null);
    rerender();
    if (tracker.current.done) finish(); else startMain();
  }

  function skipWord() {
    tracker.current.skipped(mistake.i);
    resumeAfterMistake();
  }

  /** Распознавание ошиблось: слово засчитывается как прочитанное верно. */
  function acceptWord() {
    tracker.current.accept(mistake.i);
    resumeAfterMistake();
  }

  async function finish() {
    stopAll();
    const s = tracker.current.summary();
    setResult(s);
    setPhase('result');
    try {
      const g = await api.post('/api/game/read', { bookId: book.id, chapter: chapter.idx, para, stats: s });
      setGame(g);
      const q = await api.post('/api/game/quiz', { bookId: book.id, chapter: chapter.idx, para });
      setQuestions(q);
    } catch (e) {
      setError(e.message);
    }
  }

  async function answer(option) {
    const q = questions[qIndex];
    if (qState.done) return;
    const right = option === q.correct;
    const tries = qState.tries + 1;
    if (right || tries >= 2) {
      const res = right ? (tries === 1 ? 'first' : 'second') : 'wrong';
      setQState({ tries, picked: option, done: true, res });
      const r = await api.post('/api/game/quiz/answer', { bookId: book.id, chapter: chapter.idx, para, item: q, result: res });
      setGame(r.summary);
      setQuizPoints((p) => p + r.points);
      speakText(q.word, { id: 'ra-q', lang: book.lang });
    } else {
      setQState({ tries, picked: option, done: false });
    }
  }

  const nextQuestion = () => {
    if (qIndex + 1 < questions.length) { setQIndex(qIndex + 1); setQState({ tries: 0, picked: null, done: false }); }
    else setPhase('end');
  };

  // Текст длинного абзаца прокручивается за читающим.
  useEffect(() => {
    const el = document.querySelector('.ra-scroll .ra-w.next, .ra-scroll .ra-w.error') || [...document.querySelectorAll('.ra-scroll .ra-w.ok, .ra-scroll .ra-w.reading')].pop();
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [tentative, phase]);

  // Клавиши: Esc — закрыть, пробел — начать.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === ' ' && phase === 'ready') { e.preventDefault(); startMain(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Состояние токена из состояний его слов.
  const tr = tracker.current;
  const tokenState = (si, ti) => {
    if (!tr) return 'pending';
    const idx = [];
    tr.words.forEach((w, k) => { if (w.s === si && w.t === ti) idx.push(k); });
    if (!idx.length) return tr.pos > 0 && words.some((w, k) => k < tr.pos && (w.s > si || (w.s === si && w.t > ti))) ? 'ok' : 'pending';
    const st = idx.map((k) => tr.state[k]);
    if (st.includes('error')) return 'error';
    if (st.every((x) => x === 'pending')) return idx[0] < tentative ? 'reading' : idx[0] === tr.pos && phase === 'listening' ? 'next' : 'pending';
    if (st.includes('pending')) return 'reading';
    if (st.includes('skipped')) return 'skipped';
    if (st.includes('fixed')) return 'fixed';
    return st.every((x) => x === 'auto') ? 'auto' : 'ok';
  };
  const popsFor = (si, ti) => pops.filter((p) => tr?.words[p.i]?.s === si && tr.words[p.i].t === ti);

  const stats = tr ? tr.summary() : null;
  const lvl = game || null;
  const q = questions?.[qIndex];

  return (
    <div className="ra-backdrop">
      <div className={`ra-scroll phase-${phase}`} role="dialog" aria-label="Чтение вслух">
        <header className="ra-head">
          <div className="ra-title">Испытание чтеца</div>
          {tr && (
            <div className="ra-score">
              <span className="ra-points">✦ {stats.wordPoints}</span>
              <span className={`ra-combo${tr.combo >= 10 ? ' hot' : ''}`}>комбо ×{comboMultiplier(Math.max(0, tr.combo - 1))} · {tr.combo}</span>
              {phase === 'listening' || phase === 'mistake' ? <span className="ra-mic" title="Микрофон"><i style={{ transform: `scaleY(${0.15 + level * 0.85})` }} /></span> : null}
            </div>
          )}
          <button className="icon ra-close" onClick={onClose} title="Закрыть (Esc)">×</button>
        </header>

        <div className="ra-text" lang={book.lang}>
          {sentences.map((s, si) => (
            <span key={s.id}>
              {tokensOf(s).map((t, ti) => (
                <span key={ti}>
                  {ti > 0 ? (t.gap || ' ') : si > 0 ? ' ' : ''}
                  <span className={`ra-w ${tokenState(si, ti)}`}>
                    {t.en}
                    {popsFor(si, ti).map((p) => <span key={p.id} className="ra-pop">{p.text}</span>)}
                  </span>
                </span>
              ))}
            </span>
          ))}
        </div>

        {error && <p className="error ra-msg">{error}</p>}

        {phase === 'loading' && !error && <p className="ra-msg muted">Готовлю свиток и распознавание речи…</p>}
        {phase === 'ready' && (
          <div className="ra-actions">
            <p className="muted">Прочитайте абзац вслух. Слова будут проявляться по мере чтения; неверно прочитанное слово остановит испытание.</p>
            <button className="primary big" onClick={startMain}>🎙 Начать чтение</button>
            <div className="muted small">пробел — начать · Esc — выйти</div>
          </div>
        )}
        {phase === 'listening' && <p className="ra-msg muted">Слушаю… Читайте в обычном темпе.</p>}

        {phase === 'mistake' && mistake && tr && (
          <div className="ra-mistake">
            <div className="ra-m-word">
              <span>{tr.words[mistake.i].w}</span>
              <button className="icon" onClick={() => speakText(tr.words[mistake.i].w, { id: 'ra-word', lang: book.lang })} title="Прослушать ещё раз">🔊</button>
            </div>
            {mistake.heard && <div className="muted small">Услышано: «{mistake.heard}»</div>}
            <div className="ra-m-status">
              {mistake.status === 'give-up' ? 'Не получается — можно пропустить слово без очков.'
                : mistake.status === 'again' ? 'Ещё раз — повторите слово.'
                : 'Послушайте и повторите это слово.'}
            </div>
            <div className="ra-actions row">
              <button className="small" onClick={skipWord}>Пропустить слово</button>
              {mistake.status === 'give-up' && <button className="small" onClick={() => listenRepeat(mistake.i, 0)}>Попробовать снова</button>}
              <button className="small link" onClick={acceptWord} title="Распознавание ошиблось — засчитать слово">я прочитал правильно</button>
            </div>
          </div>
        )}

        {phase === 'result' && result && (
          <div className="ra-result">
            <div className="ra-stars">{[1, 2, 3].map((n) => <span key={n} className={n <= result.stars ? 'on' : ''} style={{ animationDelay: `${n * 0.25}s` }}>★</span>)}</div>
            <div className="ra-breakdown">
              <div>Слова: <b>{result.ok}</b> из {result.words - result.skipped}{result.fixed ? `, исправлено ${result.fixed}` : ''}</div>
              <div>Точность: <b>{Math.round(result.accuracy * 100)} %</b> · лучшее комбо: <b>{result.maxCombo}</b></div>
              <div>Очки: {result.wordPoints} + бонус {result.bonus} = <b className="ra-total">✦ {result.points}</b></div>
            </div>
            {lvl && <LevelBar g={lvl} />}
            {questions === null ? <p className="muted small">Готовлю испытание знаний…</p>
              : questions.length ? <button className="primary" onClick={() => setPhase('quiz')}>Испытание знаний: {questions.length} {questions.length === 1 ? 'слово' : 'слова'} ›</button>
              : <EndButtons hasNext={hasNext} onNext={onNext} onClose={onClose} />}
          </div>
        )}

        {phase === 'quiz' && q && (
          <div className="ra-quiz">
            <div className="ra-q-head muted small">Испытание знаний · {qIndex + 1} из {questions.length}{quizPoints ? ` · ✦ ${quizPoints}` : ''}</div>
            <div className="ra-q-word">{q.word}</div>
            <div className="ra-q-sentence"><QuizSentence q={q} /></div>
            <div className="ra-q-options">
              {q.options.map((o) => {
                const cls = qState.done && o === q.correct ? 'right' : qState.picked === o && o !== q.correct ? 'wrong' : '';
                return <button key={o} className={cls} onClick={() => answer(o)} disabled={qState.done || (qState.picked === o && o !== q.correct)}>{o}</button>;
              })}
            </div>
            {!qState.done && qState.tries === 1 && <div className="muted small">Не то — есть ещё одна попытка.</div>}
            {qState.done && (
              <div className="ra-q-after">
                <div>
                  {qState.res === 'first' ? <b className="ok-text">Верно! +20</b> : qState.res === 'second' ? <b>Со второй попытки: +5</b> : <b className="error">Правильно: «{q.correct}»</b>}
                  {qState.res !== 'first' && <span className="muted small"> · слово добавлено в «Слова» для повторения</span>}
                </div>
                {q.base && <div className="muted small">Словарь: {q.base}</div>}
                <button className="primary" onClick={nextQuestion}>{qIndex + 1 < questions.length ? 'Дальше ›' : 'Готово ›'}</button>
              </div>
            )}
          </div>
        )}

        {phase === 'end' && (
          <div className="ra-result">
            <div className="ornament">❦</div>
            <div className="ra-breakdown">
              <div>За абзац: <b className="ra-total">✦ {(result?.points || 0) + quizPoints}</b></div>
            </div>
            {lvl && <LevelBar g={lvl} />}
            <EndButtons hasNext={hasNext} onNext={onNext} onClose={onClose} />
          </div>
        )}
      </div>
    </div>
  );
}

function QuizSentence({ q }) {
  const at = q.sentence.indexOf(q.token.en);
  if (at < 0) return <span>{q.sentence}</span>;
  return <span>{q.sentence.slice(0, at)}<mark>{q.token.en}</mark>{q.sentence.slice(at + q.token.en.length)}</span>;
}

function EndButtons({ hasNext, onNext, onClose }) {
  return (
    <div className="ra-actions row">
      {hasNext && <button className="primary" onClick={onNext}>Следующий абзац ›</button>}
      <button onClick={onClose}>К книге</button>
    </div>
  );
}

export function LevelBar({ g }) {
  const info = levelInfo(g.xp);
  return (
    <div className="ra-level">
      <div className="ra-level-head"><b>{info.title}</b> · уровень {info.level} <span className="muted small">✦ {g.xp} / {info.to}</span></div>
      <div className="ra-level-track"><span style={{ width: `${Math.round(info.progress * 100)}%` }} /></div>
      {g.streak?.days > 0 && <div className="muted small">🔥 Серия: {g.streak.days} {g.streak.days === 1 ? 'день' : g.streak.days < 5 ? 'дня' : 'дней'}</div>}
    </div>
  );
}
