import { useEffect, useState } from 'react';
import { useSettings, updateSettings, HINT_MODES, HINT_MODE_LABELS, RU_MODES, RU_MODE_LABELS } from '../lib/settings.js';
import { api } from '../lib/api.js';
import { playUrl, useSpeakingId } from '../lib/tts.js';
import { useServerEvents } from '../lib/events.js';
import { formatEta } from './QueueStatus.jsx';

const PROVIDERS = [
  ['claude-code', 'Claude Code (подписка, claude -p)'],
  ['ollama', 'Ollama (локально)'],
  ['stub', 'Без перевода (проверка интерфейса)'],
];

const OLLAMA_MODELS = [
  ['qwen3:8b', 'qwen3:8b — качество лучше, ~5 ГБ RAM'],
  ['gemma3:4b', 'gemma3:4b — быстрее, ~3 ГБ RAM'],
];

function OllamaSection({ s, set }) {
  const [info, setInfo] = useState(null);
  const [books, setBooks] = useState([]);
  const [bookId, setBookId] = useState('');
  const [bench, setBench] = useState(null);
  const [busy, setBusy] = useState('');
  const load = () => api.get('/api/ollama').then(setInfo).catch(() => {});
  useEffect(() => { load(); api.get('/api/books').then(setBooks).catch(() => {}); }, []);
  useServerEvents((ev) => { if (ev.type === 'ollama') { if (ev.pulling) setInfo((i) => i && { ...i, pulling: ev.pulling }); else load(); } });

  const model = s.ollamaModel || 'qwen3:8b';
  const has = info?.models?.some((m) => m === model || m === model + ':latest');
  const run = async (what, fn) => {
    setBusy(what);
    try { await fn(); } catch (e) { setBench({ error: e.message }); } finally { setBusy(''); load(); }
  };
  const pull = () => run('pull', () => api.post('/api/ollama/pull', { model }));
  const start = () => run('start', () => api.post('/api/ollama/start'));
  const measure = () => run('bench', async () => setBench(await api.post('/api/ollama/benchmark', { model, bookId: bookId || undefined })));
  const p = info?.pulling;
  const options = [...new Set([...OLLAMA_MODELS.map((m) => m[0]), ...(info?.models || [])])];

  return (
    <div className="sub-section">
      <p className="muted small">
        {!info ? 'Проверяю Ollama…'
          : !info.installed ? 'Ollama не найден (ожидается в D:\bookreader-data\ollama).'
          : info.running ? `Ollama запущен${info.ownProcess ? ' приложением' : ''}. Модели: ${info.models.join(', ') || 'нет'}.`
          : 'Ollama установлен, сервер запустится при первом переводе.'}
        {info?.installed && !info.running && <button className="link small" onClick={start} disabled={!!busy}>запустить сейчас</button>}
      </p>
      <div className="form-grid3">
        <label>Модель
          <select value={model} onChange={set('ollamaModel')}>
            {options.map((m) => <option key={m} value={m}>{OLLAMA_MODELS.find((x) => x[0] === m)?.[1] || m}</option>)}
          </select>
        </label>
        <label>Потоков CPU
          <input type="number" min="1" max="12" value={s.ollamaThreads ?? 6} onChange={set('ollamaThreads')} />
        </label>
        <label>Замер на книге
          <select value={bookId} onChange={(e) => setBookId(e.target.value)}>
            <option value="">примеры фраз</option>
            {books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
        </label>
      </div>
      <div className="form-row">
        {info?.installed && !has && !p && <button onClick={pull} disabled={!!busy}>Скачать модель {model}</button>}
        {p && <span>Скачивается {p.model}: {p.total ? Math.round((p.completed / p.total) * 100) + '%' : p.status}</span>}
        {has && <button onClick={measure} disabled={!!busy}>{busy === 'bench' ? 'Замеряю…' : 'Замерить скорость (5 предложений)'}</button>}
      </div>
      {bench && (bench.error ? <p className="error small">{bench.error}</p> : (
        <p className="small">
          {bench.model}, {bench.threads} потоков: {bench.secPerSentence.toFixed(1)} с на предложение
          ({bench.n} за {bench.seconds.toFixed(0)} с).
          {bench.pending != null && <> Оценка на всю книгу ({bench.pending} предл.): <b>{formatEta(bench.etaMin)}</b>.</>}
          {bench.cached ? ` Переводы замера сохранены (${bench.cached}).` : ''}
        </p>
      ))}
    </div>
  );
}

function TtsSection({ s, set }) {
  const [st, setSt] = useState(null);
  const [sample, setSample] = useState('');
  const speakingId = useSpeakingId();
  const load = () => api.get('/api/tts/status').then(setSt).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  useServerEvents((ev) => { if (ev.type === 'tts') load(); });

  const listen = async () => {
    setSample('Генерирую пример…');
    try {
      const r = await fetch('/api/tts/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: s.ttsVoice, speed: s.ttsSpeed }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const url = URL.createObjectURL(await r.blob());
      setSample('');
      await playUrl(url, 'sample');
      URL.revokeObjectURL(url);
    } catch (e) {
      setSample(e.message);
    }
  };
  const resetAll = async () => {
    if (!window.confirm('Удалить всю готовую озвучку и сгенерировать её заново текущим голосом?')) return;
    await api.post('/api/tts/reset', {});
    load();
  };

  const voices = st?.voices?.length ? st.voices : [{ id: s.ttsVoice || 'af_heart', name: s.ttsVoice || 'af_heart', language: '', gender: '', overallGrade: '' }];
  return (
    <section>
      <h2>Озвучка (Kokoro-82M, на этом компьютере)</h2>
      <div className="form-grid3">
        <label>Голос
          <select value={s.ttsVoice || 'af_heart'} onChange={set('ttsVoice')}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>{v.name} — {v.language === 'en-gb' ? 'британский' : 'американский'}, {v.gender === 'Female' ? 'жен.' : 'муж.'}{v.overallGrade ? `, оценка ${v.overallGrade}` : ''}</option>
            ))}
          </select>
        </label>
        <label>Скорость: {Number(s.ttsSpeed || 1).toFixed(2)}×
          <input type="range" min="0.6" max="1.4" step="0.05" value={s.ttsSpeed || 1} onChange={set('ttsSpeed')} />
        </label>
        <label>Потоков CPU для озвучки
          <input type="number" min="1" max="8" value={s.ttsThreads ?? 4} onChange={set('ttsThreads')} />
        </label>
      </div>
      <div className="form-row">
        <button className={speakingId === 'sample' ? 'active' : ''} onClick={listen}>🔊 Прослушать пример</button>
        {sample && <span className="muted">{sample}</span>}
      </div>
      <label className="check"><input type="checkbox" checked={!!s.ttsEnabled} onChange={set('ttsEnabled')} /> Озвучивать переведённые главы в фоне</label>
      <label className="check"><input type="checkbox" checked={!!s.ttsPaused} onChange={set('ttsPaused')} /> Пауза фоновой озвучки</label>
      {st && (
        <p className="muted small">
          Состояние: {st.status === 'ready' ? 'модель загружена' : st.status === 'loading' ? 'загружается модель…' : st.status === 'error' ? `ошибка: ${st.error}` : 'не запущена'}
          {st.speedX ? ` · скорость ${st.speedX}× реального времени` : ''}
          {' · '}формат {st.encoder}
          {' · '}без озвучки {st.left} предл.{st.background ? ' · озвучиваю в фоне' : ''}
        </p>
      )}
      <p className="muted small">
        Голос и скорость применяются к новой озвучке. Готовые файлы остаются прежними —
        <button className="link small" onClick={resetAll}>переозвучить всё заново</button>.
        Пока идёт перевод через Ollama, фоновая озвучка ждёт, чтобы не занимать все ядра.
      </p>
    </section>
  );
}

export default function Settings() {
  const s = useSettings();
  const set = (k) => (e) => {
    const v = e.target.type === 'number' || e.target.type === 'range' ? Number(e.target.value)
      : e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    updateSettings({ [k]: v });
  };

  return (
    <div className="page narrow settings">
      <h1>Настройки</h1>

      <section>
        <h2>Перевод</h2>
        <label>Провайдер
          <select value={s.provider || 'claude-code'} onChange={set('provider')}>
            {PROVIDERS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        {(s.provider || 'claude-code') === 'claude-code' && (
          <label>Режим
            <select value={s.glossMode || 'fast'} onChange={set('glossMode')}>
              <option value="fast">быстрый — разбивка и леммы локально, модель даёт переводы (~4× быстрее)</option>
              <option value="full">полный — модель размечает всё сама, включая словарные значения</option>
            </select>
          </label>
        )}
        {(s.provider || 'claude-code') === 'claude-code' && (
          <div className="form-grid3">
            <label>Модель
              <select value={s.claudeModel || 'sonnet'} onChange={set('claudeModel')}>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
                <option value="opus">opus</option>
              </select>
            </label>
            <label>Усилие (effort)
              <select value={s.claudeEffort || 'low'} onChange={set('claudeEffort')}>
                <option value="low">low — быстрее</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
            <label>Параллельных запросов
              <input type="number" min="1" max="10" value={s.parallel ?? 10} onChange={set('parallel')} />
            </label>
          </div>
        )}
        {s.provider === 'ollama' && <OllamaSection s={s} set={set} />}
        <label>Размер пачки (предложений за запрос)
          <input type="number" min="1" max="60" value={s.batchSize ?? 40} onChange={set('batchSize')} />
        </label>
        <p className="muted small">
          Claude Code вызывается в headless-режиме по вашей подписке, без API-ключа. Если подписка упрётся в лимит,
          очередь встанет на паузу и продолжит сама после сброса лимита. Каждый параллельный запрос — отдельный
          процесс claude (~200 МБ памяти); больше запросов — быстрее, но лимит подписки расходуется быстрее.
          В полном режиме пачка не больше 12 предложений, в быстром словарные значения слов догружаются
          отдельно (модель {s.dictModel || 'haiku'}) и кэшируются для всех книг.
        </p>
      </section>

      <TtsSection s={s} set={set} />

      <section>
        <h2>Чтение</h2>
        <div className="form-grid3">
          <label>Оформление
            <select value={s.theme || 'auto'} onChange={set('theme')}>
              <option value="auto">как в системе</option>
              <option value="light">пергамент (светлая)</option>
              <option value="dark">ночная библиотека (тёмная)</option>
            </select>
          </label>
          <label>Размер текста: {Math.round((s.fontScale || 1) * 100)} % (клавиши + и −)
            <input type="range" min="0.8" max="1.6" step="0.05" value={s.fontScale || 1} onChange={set('fontScale')} />
          </label>
          <label className="check"><input type="checkbox" checked={!!s.immersive} onChange={set('immersive')} /> Режим погружения (клавиша F)</label>
        </div>
        <label>Испытание чтеца (клавиша R): строгость проверки произношения
          <select value={s.readStrictness || 'normal'} onChange={set('readStrictness')}>
            <option value="soft">мягко — сильный акцент, останавливает только на явных ошибках</option>
            <option value="normal">обычно — лёгкий акцент не считается ошибкой</option>
            <option value="strict">строго — неуверенно прочитанное слово тоже ошибка, остановка сразу</option>
          </select>
        </label>
        <p className="muted small">
          Речь распознаётся на этом компьютере (Vosk, в браузере): звук никуда не отправляется. Распознавание ловит
          слова, которые прочитаны не так, как написано, но не оценивает тонкости произношения (th, ударение).
        </p>
        <label>Подсказки над словами (клавиша H)
          <select value={s.hintMode || 'visible'} onChange={set('hintMode')}>
            {HINT_MODES.map((m) => <option key={m} value={m}>{HINT_MODE_LABELS[m]}</option>)}
          </select>
        </label>
        <label>Колонка полного перевода (клавиша T)
          <select value={s.ruColumn || 'show'} onChange={set('ruColumn')}>
            {RU_MODES.map((m) => <option key={m} value={m}>{RU_MODE_LABELS[m]}</option>)}
          </select>
        </label>
      </section>
    </div>
  );
}
