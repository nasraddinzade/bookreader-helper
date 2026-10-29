// Подписка на события сервера (SSE): прогресс перевода, озвучки, состояние очередей.

import { useEffect, useRef } from 'react';

const listeners = new Set();
let source = null;

function ensure() {
  if (source) return;
  source = new EventSource('/api/events');
  source.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    listeners.forEach((fn) => fn(ev));
  };
}

export function onServerEvent(fn) {
  ensure();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Хук: вызывает handler на каждое событие; handler можно менять между рендерами. */
export function useServerEvents(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onServerEvent((ev) => ref.current(ev)), []);
}
