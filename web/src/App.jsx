import { useRoute } from './lib/route.js';
import Library from './components/Library.jsx';
import Reader from './components/Reader.jsx';
import Settings from './components/Settings.jsx';

const NAV = [
  ['library', 'Библиотека'],
  ['settings', 'Настройки'],
];

export default function App() {
  const { page, param } = useRoute();
  let screen;
  switch (page) {
    case 'read': screen = <Reader key={param.split('/')[0]} param={param} />; break;
    case 'settings': screen = <Settings />; break;
    default: screen = <Library />;
  }
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/library">Книжная читалка</a>
        <nav>
          {NAV.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={page === id || (id === 'library' && page === 'read') ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main className={`screen screen-${page}`}>{screen}</main>
    </div>
  );
}
