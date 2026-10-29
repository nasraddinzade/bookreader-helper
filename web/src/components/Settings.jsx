import { useEffect, useState } from 'react';
import { useSettings, updateSettings, HINT_MODES, HINT_MODE_LABELS, RU_MODES, RU_MODE_LABELS } from '../lib/settings.js';
import { api } from '../lib/api.js';
import { playUrl, useSpeakingId } from '../lib/tts.js';
import { useServerEvents } from '../lib/events.js';

const PROVIDERS = [
  ['claude-code', 'Claude Code (подписка, claude -p)'],
  ['ollama', 'Ollama (локально)'],
  ['stub', 'Без перевода (проверка интерфейса)'],
];

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
              <input type="number" min="1" max="4" value={s.parallel ?? 2} onChange={set('parallel')} />
            </label>
          </div>
        )}
        <label>Размер пачки (предложений за запрос)
          <input type="number" min="1" max="30" value={s.batchSize ?? 12} onChange={set('batchSize')} />
        </label>
        <p className="muted small">
          Claude Code вызывается в headless-режиме по вашей подписке, без API-ключа. Если подписка упрётся в лимит,
          очередь встанет на паузу и продолжит сама после сброса лимита.
        </p>
      </section>

      <TtsSection s={s} set={set} />

      <section>
        <h2>Чтение</h2>
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
