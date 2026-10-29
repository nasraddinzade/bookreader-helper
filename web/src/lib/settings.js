// Настройки хранятся на сервере; здесь — кэш с мгновенным обновлением интерфейса.

import { useSyncExternalStore } from 'react';
import { api } from './api.js';
import { onServerEvent } from './events.js';

export const HINT_MODES = ['visible', 'hover', 'off'];
export const HINT_MODE_LABELS = {
  visible: 'Подсказки: видны',
  hover: 'Подсказки: по наведению',
  off: 'Подсказки: скрыты',
};
export const RU_MODES = ['show', 'hide', 'click'];
export const RU_MODE_LABELS = {
  show: 'Перевод: колонка',
  hide: 'Перевод: скрыт',
  click: 'Перевод: по клику',
};

const LOCAL_KEY = 'br.settings';
let state = (() => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}; } catch { return {}; } })();
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

function set(next) {
  state = next;
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  notify();
}

export async function loadSettings() {
  try { set(await api.get('/api/settings')); } catch { /* сервер ещё не поднялся */ }
}
loadSettings();
onServerEvent((ev) => { if (ev.type === 'settings') loadSettings(); });

export function getSettings() {
  return state;
}

export async function updateSettings(patch) {
  set({ ...state, ...patch });
  try { set(await api.put('/api/settings', patch)); } catch (e) { console.warn('settings', e); }
}

export function useSettings() {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => state,
    () => state,
  );
}
