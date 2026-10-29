import { useSettings, updateSettings, HINT_MODES, HINT_MODE_LABELS, RU_MODES, RU_MODE_LABELS } from '../lib/settings.js';

const PROVIDERS = [
  ['claude-code', 'Claude Code (подписка, claude -p)'],
  ['ollama', 'Ollama (локально)'],
  ['stub', 'Без перевода (проверка интерфейса)'],
];

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
