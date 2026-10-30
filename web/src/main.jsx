import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Шрифты лежат локально (npm @fontsource), интернет не нужен; у всех есть кириллица.
import '@fontsource/forum/400.css'; // заголовки: римские капители
import '@fontsource/eb-garamond/400.css'; // английский текст книги
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/600.css';
import '@fontsource/literata/400.css'; // переводы, подсказки и интерфейс
import '@fontsource/literata/400-italic.css';
import '@fontsource/literata/600.css';
import App from './App.jsx';

// Для диагностики распознавания из консоли браузера (модуль тяжёлый — грузится по требованию).
window.__speech = () => import('./lib/speech.js');
import './index.css';
import './theme.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
