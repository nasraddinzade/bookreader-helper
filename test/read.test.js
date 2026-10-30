import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadTracker, paragraphWords, sameWord, levelInfo } from '../shared/read-align.js';

const S = 'There was nothing so very remarkable in that; nor did Alice think it so very much out of the way to hear the Rabbit say to itself, “Oh dear!';
const words = () => paragraphWords([{ id: 1, text: S }]);
// Слова «по тексту» с уверенностью и временем: по 0.3 с на слово.
const said = (list, conf = {}) => list.map((w, k) => ({ word: w, conf: conf[k] ?? 1, start: k * 0.3, end: k * 0.3 + 0.25 }));
const ALL = S.toLowerCase().replace(/[^a-z'\s]/g, ' ').split(/\s+/).filter(Boolean);

test('верное чтение: все слова ok, комбо растёт, 3 звезды', () => {
  const tr = new ReadTracker(words());
  tr.final(said(ALL));
  assert.ok(tr.done);
  const s = tr.summary();
  assert.equal(s.stars, 3);
  assert.equal(s.maxCombo, ALL.length);
  assert.ok(s.points > ALL.length * 10);
});

test('слово притянуто к тексту с низкой уверенностью, «свободный» слышит другое — ошибка', () => {
  const tr = new ReadTracker(words());
  const i = ALL.indexOf('say');
  const r2 = said(ALL, { [i]: 0.85 });
  tr.addFree(r2.map((w, k) => (k === i ? { ...w, word: 'sing' } : w)));
  const ev = tr.final(r2);
  const err = ev.at(-1);
  assert.equal(err.type, 'error');
  assert.equal(tr.words[err.i].w, 'say');
  assert.equal(err.heard, 'sing');
  assert.ok(tr.paused);
  tr.fixed(err.i);
  tr.final(said(ALL.slice(i + 1)));
  assert.ok(tr.done);
  assert.equal(tr.state[i], 'fixed');
});

test('низкая уверенность, но «свободный» слышит то же слово (с окончанием) — засчитано', () => {
  const tr = new ReadTracker(words());
  const i = ALL.indexOf('rabbit');
  const r2 = said(ALL, { [i]: 0.6 });
  tr.addFree(r2.map((w, k) => (k === i ? { ...w, word: 'rabbits' } : w)));
  assert.ok(!tr.final(r2).some((e) => e.type === 'error'));
  assert.ok(tr.done);
});

test('[unk] вместо слова — ошибка на нём; partial ловит её сразу, если чтение продолжилось', () => {
  const tr = new ReadTracker(words());
  const i = ALL.indexOf('remarkable');
  // Одна нестабильная гипотеза не останавливает; [unk], державшийся 3 обновления, — останавливает.
  const hyp = (n) => ALL.slice(0, i).concat('[unk]', ...ALL.slice(i + 1, i + 1 + n)).join(' ');
  assert.ok(!tr.partial(hyp(3)).unk);
  assert.ok(!tr.partial(hyp(4)).unk);
  const p = tr.partial(hyp(5));
  assert.equal(p.upTo, i);
  assert.ok(p.unk);
  // По служебному слову досрочной остановки нет.
  const tr3 = new ReadTracker(words());
  const iIt = ALL.indexOf('it');
  for (let n = 3; n < 8; n++) assert.ok(!tr3.partial(ALL.slice(0, iIt).concat('[unk]', ...ALL.slice(iIt + 1, iIt + 1 + n)).join(' ')).unk);
  const ev = tr.final(said(ALL.slice(0, i).concat('[unk]', ...ALL.slice(i + 2))));
  assert.equal(ev.at(-1).type, 'error');
  assert.equal(tr.words[ev.at(-1).i].w, 'remarkable');
});

test('пропуск служебного слова не ошибка, пропуск значимого — ошибка', () => {
  const tr = new ReadTracker(words());
  const iOf = ALL.indexOf('of');
  tr.final(said(ALL.filter((_, k) => k !== iOf)));
  assert.ok(tr.done);
  const tr2 = new ReadTracker(words());
  const iRem = ALL.indexOf('remarkable');
  const ev = tr2.final(said(ALL.filter((_, k) => k !== iRem)));
  assert.equal(tr2.words[ev.at(-1).i].w, 'remarkable');
});

test('слова вне словаря распознавателя пропускаются автоматически', () => {
  const w = paragraphWords([{ id: 1, text: 'Fancy curtseying as you fall!' }]);
  w.find((x) => x.w === 'curtseying').check = false;
  const tr = new ReadTracker(w);
  tr.final(said(['fancy', 'as', 'you', 'fall']));
  assert.ok(tr.done);
  assert.equal(tr.state[1], 'auto');
});

test('sameWord и уровни', () => {
  assert.ok(sameWord('It’s', 'it'));
  assert.ok(!sameWord('sing', 'say'));
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(150).level, 2);
  assert.equal(levelInfo(150).title, 'Ученик');
  assert.equal(levelInfo(1000).title, 'Переписчик');
  assert.equal(levelInfo(2000).title, 'Книжник');
});

test('слово вне словаря звучит как [unk] — это не ошибка; дефисные слова проверяются по частям', () => {
  const w = paragraphWords([{ id: 1, text: 'The rabbit-hole went on; fancy curtseying as you fall!' }]);
  assert.deepEqual(w.slice(0, 3).map((x) => x.w), ['the', 'rabbit', 'hole']);
  w.find((x) => x.w === 'curtseying').check = false;
  const tr = new ReadTracker(w);
  assert.ok(!tr.partial('the rabbit hole went on fancy [unk] as you fall').unk);
  const ev = tr.final(said(['the', 'rabbit', 'hole', 'went', 'on', 'fancy', '[unk]', 'as', 'you', 'fall']));
  assert.ok(!ev.some((e) => e.type === 'error'));
  assert.ok(tr.done);
});
