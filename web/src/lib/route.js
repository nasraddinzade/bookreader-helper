import { useSyncExternalStore } from 'react';

function parse() {
  const h = (window.location.hash || '#/library').replace(/^#\/?/, '');
  const [page, ...rest] = h.split('/');
  return { page: page || 'library', param: rest.join('/') ? decodeURIComponent(rest.join('/')) : '' };
}

let current = parse();
const listeners = new Set();
window.addEventListener('hashchange', () => { current = parse(); listeners.forEach((fn) => fn()); });

export function navigate(path) {
  window.location.hash = '#/' + path.replace(/^\/+/, '');
}

export function useRoute() {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => current,
    () => current,
  );
}
