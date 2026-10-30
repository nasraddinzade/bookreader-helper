import { useEffect, useState } from 'react';
import { speakText, speakSentence, useSpeakingId } from '../lib/tts.js';
import { vocabApi, cleanCtx } from '../lib/vocab.js';
import { api } from '../lib/api.js';

const clean = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Карточка слова: ctx, base, lemma, часть речи, озвучка слова и предложения, «Запомнить». */
export default function WordCard({ token, sentence, book, chapter, onClose }) {
  const [existing, setExisting] = useState(null);
  const [msg, setMsg] = useState('');
  const speakingId = useSpeakingId();
  const lang = book.lang;

  useEffect(() => {
    let alive = true;
    vocabApi.lookup('word', lang, clean(token.en), token.lemma).then((w) => { if (alive) setExisting(w); }).catch(() => {});
    return () => { alive = false; };
  }, [token, lang]);

  // Многословный блок («I wonder», «went on»): показываем и значения отдельных слов.
  const multi = clean(token.en).split(/\s+/).length > 1;
  const [parts, setParts] = useState(null);
  useEffect(() => {
    if (!multi) return undefined;
    let alive = true;
    let tries = 0;
    const load = () => api.get(`/api/dict/words?lang=${encodeURIComponent(lang)}&tgt=${encodeURIComponent(book.targetLang)}&text=${encodeURIComponent(clean(token.en))}`)
      .then((r) => {
        if (!alive) return;
        setParts(r.items);
        // Каких-то слов нет в словаре — они запрошены, подождём и спросим ещё раз.
        if (r.pending && ++tries < 4) setTimeout(load, 6000);
      })
      .catch(() => {});
    load();
    return () => { alive = false; };
  }, [token, lang, book.targetLang, multi]);

  const hasExample = existing?.examples?.some((e) => e.sentence === sentence.text);

  const save = async () => {
    try {
      const r = await vocabApi.save({
        kind: 'word',
        lang,
        tgt: book.targetLang,
        text: token.en,
        lemma: token.lemma || clean(token.en).toLowerCase(),
        ctx: token.ctx,
        base: token.base,
        pos: token.pos,
        example: {
          en: token.en,
          ctx: token.ctx,
          sentence: sentence.text,
          sentenceRu: sentence.gloss?.full || '',
          bookId: book.id,
          bookTitle: book.title,
          chapter: chapter.idx,
          chapterTitle: chapter.title,
          sentenceIdx: sentence.idx,
        },
      });
      setExisting(r.item);
      setMsg(r.created ? 'Сохранено в «Слова»' : r.exampleAdded ? 'Пример добавлен к существующей записи' : 'Уже сохранено с этим примером');
    } catch (e) {
      setMsg(e.message);
    }
  };

  const showLemma = token.lemma && token.lemma.toLowerCase() !== clean(token.en).toLowerCase();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Карточка слова">
        <button className="close" onClick={onClose} aria-label="Закрыть">×</button>
        <div className="card-head">
          <span className="card-en">{clean(token.en) || token.en}</span>
          <button className={`icon${speakingId === 'card-word' ? ' active' : ''}`} title="Прослушать слово" onClick={() => speakText(token.en, { id: 'card-word', lang })}>🔊</button>
          {token.pos && <span className="chip">{token.pos}</span>}
        </div>
        <dl className="card-grid">
          <dt>В контексте</dt><dd>{cleanCtx(token.ctx) || <span className="muted">—</span>}</dd>
          <dt>Начальная форма</dt><dd>{showLemma ? token.lemma : <span className="muted">{token.lemma || '—'}</span>}</dd>
          <dt>Словарь</dt><dd>{token.base || <span className="muted">—</span>}</dd>
        </dl>
        {multi && (
          <div className="card-parts">
            <div className="card-parts-title">По словам</div>
            {!parts ? <span className="muted small">…</span> : (
              <ul>
                {parts.map((p, i) => (
                  <li key={i}>
                    <button className={`icon${speakingId === `card-part-${i}` ? ' active' : ''}`} title="Прослушать" onClick={() => speakText(p.word, { id: `card-part-${i}`, lang })}>🔊</button>
                    <b>{p.word}</b>
                    {p.lemma && p.lemma !== p.word.toLowerCase() && <span className="muted"> → {p.lemma}</span>}
                    <span> — {p.base || <span className="muted">значение загружается…</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="card-sentence">
          <button className={`icon${speakingId === 'card-sent' ? ' active' : ''}`} title="Прослушать предложение" onClick={() => speakSentence(sentence, { id: 'card-sent', lang })}>🔊</button>
          <div>
            <div>{sentence.text}</div>
            {sentence.gloss?.full && <div className="muted">{sentence.gloss.full}</div>}
          </div>
        </div>
        <div className="card-actions">
          {existing && hasExample ? (
            <button disabled>✓ Запомнено</button>
          ) : (
            <button className="primary" onClick={save}>{existing ? '+ Запомнить с этим примером' : 'Запомнить'}</button>
          )}
          {existing && <a href="#/words" className="muted small-link">в «Слова» ({existing.examples.length} прим.)</a>}
          {msg && <span className="muted">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
