// Значок в шапке: звание, уровень, полоса опыта и серия дней.

import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useServerEvents } from '../lib/events.js';

export default function GameBadge() {
  const [g, setG] = useState(null);
  const load = () => api.get('/api/game').then(setG).catch(() => {});
  useEffect(() => { load(); }, []);
  useServerEvents((ev) => { if (ev.type === 'game') load(); });
  if (!g) return null;
  const title = `${g.title}, уровень ${g.level}: ✦ ${g.xp} из ${g.to}. Сегодня: ✦ ${g.today.points}, абзацев вслух ${g.today.paragraphs}.`
    + (g.streak.days ? ` Серия ${g.streak.days} дн.${g.streak.today ? '' : ' — позанимайтесь сегодня, чтобы не прервать'}` : '');
  return (
    <span className="game-badge" title={title}>
      <span className="gb-title">{g.title}</span>
      <span>ур. {g.level}</span>
      <span className="gb-track"><span style={{ width: `${Math.round(g.progress * 100)}%` }} /></span>
      {g.streak.days > 0 && <span className="gb-streak" style={{ opacity: g.streak.today ? 1 : 0.55 }}>🔥{g.streak.days}</span>}
    </span>
  );
}
