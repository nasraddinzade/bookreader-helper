// Панель «Испытания чтеца» внизу читалки: очки и комбо, ошибка с произношением, итог, викторина.
// Сам текст абзаца проявляется прямо в книге (см. readGame.tokenClass).

import { useReadGame } from '../lib/readGame.js';
import { speakText } from '../lib/tts.js';
import { comboMultiplier, levelInfo } from '../../../shared/read-align.js';

export default function ReadHud({ onNextChapter }) {
  const game = useReadGame();
  const s = game.s;
  if (s.phase === 'idle') {
    return s.error ? <div className="ra-hud"><span className="error">{s.error}</span> <button className="icon" onClick={() => game.set({ error: '' })}>×</button></div> : null;
  }
  const tr = game.tracker;
  const stats = tr ? tr.summary() : null;
  const lang = game.book?.lang || 'en';
  const q = s.questions?.[s.qIndex];
  const paraNo = game.paragraphs().indexOf(s.para) + 1;

  return (
    <div className={`ra-hud phase-${s.phase}`} role="region" aria-label="Испытание чтеца">
      <div className="ra-hud-bar">
        <span className="ra-title">Испытание чтеца</span>
        <span className="muted small">абзац {paraNo} из {game.paragraphs().length}</span>
        {stats && <span className="ra-points">✦ {stats.wordPoints}</span>}
        {tr && <span className={`ra-combo${tr.combo >= 10 ? ' hot' : ''}`}>комбо ×{comboMultiplier(Math.max(0, tr.combo - 1))} · {tr.combo}</span>}
        {(s.phase === 'listening' || s.phase === 'mistake') && <span className="ra-mic" title="Микрофон"><i style={{ transform: `scaleY(${0.15 + s.level * 0.85})` }} /></span>}
        <span className="spacer" />
        {s.phase === 'listening' && <button className="small" onClick={() => game.pause()} title="Пауза">⏸</button>}
        {s.phase === 'paused' && <button className="small primary" onClick={() => game.resume()}>▶ Продолжить</button>}
        <button className="small" onClick={() => game.stop()} title="Закончить испытание (Esc)">✕</button>
      </div>

      {s.notice && <div className="ra-notice">{s.notice}</div>}
      {s.error && <div className="error small">{s.error}</div>}
      {s.phase === 'loading' && <div className="muted">Готовлю распознавание речи…</div>}
      {s.phase === 'listening' && <div className="muted small">Читайте абзац вслух — прочитанные слова проявятся в тексте.</div>}
      {s.phase === 'paused' && !s.error && <div className="muted small">Пауза.</div>}

      {s.phase === 'mistake' && s.mistake && tr && (
        <div className="ra-mistake">
          <div className="ra-m-word">
            <span>{tr.words[s.mistake.i].w}</span>
            <button className="icon" onClick={() => speakText(tr.words[s.mistake.i].w, { id: 'ra-word', lang })} title="Прослушать ещё раз">🔊</button>
          </div>
          <div className="ra-m-status">
            {s.mistake.status === 'give-up' ? 'Не получается — можно пропустить слово без очков.'
              : s.mistake.status === 'again' ? 'Ещё раз — повторите слово.'
              : 'Послушайте и повторите это слово.'}
            {s.mistake.heard && <span className="muted small"> Услышано: «{s.mistake.heard}».</span>}
          </div>
          <div className="ra-actions row">
            <button className="small" onClick={() => game.skipWord()}>Пропустить слово</button>
            {s.mistake.status === 'give-up' && <button className="small" onClick={() => game.retryWord()}>Попробовать снова</button>}
            <button className="small link" onClick={() => game.acceptWord()} title="Распознавание ошиблось — засчитать слово">я прочитал правильно</button>
          </div>
        </div>
      )}

      {(s.phase === 'result' || s.phase === 'quiz' || s.phase === 'next' || s.phase === 'chapter-done') && s.result && (
        <div className="ra-result-line">
          <span className="ra-stars">{[1, 2, 3].map((n) => <span key={n} className={n <= s.result.stars ? 'on' : ''} style={{ animationDelay: `${n * 0.2}s` }}>★</span>)}</span>
          <span>Точность {Math.round(s.result.accuracy * 100)} % · комбо {s.result.maxCombo}</span>
          <b className="ra-total">✦ {s.result.points + s.quizPoints}</b>
          {s.game && <LevelBar g={s.game} />}
        </div>
      )}

      {s.phase === 'quiz' && q && (
        <div className="ra-quiz">
          <div className="ra-q-head muted small">Испытание знаний · {s.qIndex + 1} из {s.questions.length}</div>
          <div className="ra-q-word">{q.word}</div>
          <div className="ra-q-sentence"><QuizSentence q={q} /></div>
          <div className="ra-q-options">
            {q.options.map((o) => {
              const cls = s.qState.done && o === q.correct ? 'right' : s.qState.picked === o && o !== q.correct ? 'wrong' : '';
              return <button key={o} className={cls} onClick={() => game.answer(o)} disabled={s.qState.done || (s.qState.picked === o && o !== q.correct)}>{o}</button>;
            })}
          </div>
          {!s.qState.done && s.qState.tries === 1 && <div className="muted small">Не то — есть ещё одна попытка.</div>}
          {s.qState.done && (
            <div className="ra-q-after">
              {s.qState.res === 'first' ? <b className="ok-text">Верно! +20</b> : s.qState.res === 'second' ? <b>Со второй попытки: +5</b> : <b className="error">Правильно: «{q.correct}»</b>}
              {s.qState.res !== 'first' && <span className="muted small">слово добавлено в «Слова» для повторения</span>}
              {q.base && <span className="muted small">Словарь: {q.base}</span>}
              <button className="primary small" onClick={() => game.nextQuestion()}>{s.qIndex + 1 < s.questions.length ? 'Дальше ›' : 'К следующему абзацу ›'}</button>
            </div>
          )}
        </div>
      )}

      {s.phase === 'next' && <div className="muted small">Следующий абзац…</div>}
      {s.phase === 'chapter-done' && (
        <div className="ra-actions row">
          <b>Глава прочитана вслух!</b>
          {onNextChapter && <button className="primary small" onClick={() => { game.stop(); onNextChapter(); }}>Следующая глава ›</button>}
          <button className="small" onClick={() => game.stop()}>Готово</button>
        </div>
      )}
    </div>
  );
}

function QuizSentence({ q }) {
  const at = q.sentence.indexOf(q.token.en);
  if (at < 0) return <span>{q.sentence}</span>;
  return <span>{q.sentence.slice(0, at)}<mark>{q.token.en}</mark>{q.sentence.slice(at + q.token.en.length)}</span>;
}

export function LevelBar({ g }) {
  const info = levelInfo(g.xp);
  return (
    <span className="ra-level" title={`✦ ${g.xp} из ${info.to}`}>
      <b>{info.title}</b> · ур. {info.level}
      <span className="ra-level-track"><span style={{ width: `${Math.round(info.progress * 100)}%` }} /></span>
      {g.streak?.days > 0 && <span className="gb-streak">🔥{g.streak.days}</span>}
    </span>
  );
}
