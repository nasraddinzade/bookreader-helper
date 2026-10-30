import { useEffect } from 'react';
import { useRoute } from './lib/route.js';
import { useSettings } from './lib/settings.js';
import Library from './components/Library.jsx';
import Reader from './components/Reader.jsx';
import Vocab from './components/Vocab.jsx';
import Review from './components/Review.jsx';
import Settings from './components/Settings.jsx';

const NAV = [
  ['library', 'Библиотека'],
  ['words', 'Слова'],
  ['phrases', 'Фразы'],
  ['review', 'Повторение'],
  ['settings', 'Настройки'],
];

export default function App() {
  const { page, param } = useRoute();
  const { theme } = useSettings();
  // Тема: пергамент / ночная библиотека; «авто» — по настройке системы.
  useEffect(() => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  let screen;
  switch (page) {
    case 'read': screen = <Reader key={param.split('/')[0]} param={param} />; break;
    case 'words': screen = <Vocab kind="word" key="w" />; break;
    case 'phrases': screen = <Vocab kind="phrase" key="p" />; break;
    case 'review': screen = <Review mode={param || 'all'} key={param || 'all'} />; break;
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
