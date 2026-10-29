// Шина событий для SSE: прогресс перевода и озвучки, состояние очередей.

import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, data) {
  bus.emit('event', { type, ...data });
}
