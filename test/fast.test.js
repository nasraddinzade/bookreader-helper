import test from 'node:test';
import assert from 'node:assert/strict';
import { mapUnits, toUnits } from '../server/gloss-fast.js';
import { joinTokens } from '../shared/align.js';

const S = '“Who are you?” said the Caterpillar, and she went to find out what kind of animal it was.';

test('fast: точный текст, многословные единицы склеивают токены, леммы локальные', () => {
  const g = ['Who', 'кто', 'are', 'есть', 'you', 'ты', 'said', 'спросила', 'the', '–', 'Caterpillar', 'Гусеница', 'and', 'и', 'she', 'она',
    'went', 'пошла', 'to', '–', 'find out', 'выяснить', 'what', 'что', 'kind of', 'за', 'animal', 'животное', 'it', 'это', 'was', 'было'];
  const { tokens, coverage } = mapUnits(S, toUnits(g));
  assert.equal(joinTokens(tokens), S);
  assert.equal(coverage, 1);
  const kind = tokens.find((t) => t.en === 'kind of');
  assert.equal(kind.ctx, 'за');
  assert.equal(kind.pos, 'idiom');
  assert.equal(tokens.find((t) => t.en === 'went').lemma, 'go');
  assert.equal(tokens.find((t) => t.en === 'find out').ctx, 'выяснить');
});

test('fast: пропущенное и лишнее слово не сдвигают остальные', () => {
  const g = ['Who', 'кто', 'you', 'ты', 'such', 'такая', 'said', 'спросила', 'Caterpillar', 'Гусеница'];
  const { tokens } = mapUnits('“Who are you?” said the Caterpillar.', toUnits(g));
  assert.equal(tokens.find((t) => t.en === 'are').ctx, 'есть'); // локальное правило для be
  assert.equal(tokens.find((t) => t.en === 'said').ctx, 'спросила');
  assert.equal(tokens.find((t) => t.en === 'Caterpillar.').ctx, 'Гусеница');
  assert.equal(joinTokens(tokens), '“Who are you?” said the Caterpillar.');
});

test('fast: единица длиннее 4 слов не склеивается', () => {
  const s = '“There’s no sort of use in knocking,” said the Footman.';
  const { tokens } = mapUnits(s, toUnits(['There’s no sort of use in', 'бесполезно', 'knocking', 'стучать']));
  assert.ok(!tokens.some((t) => t.en.split(' ').length > 4));
  assert.equal(joinTokens(tokens), s);
});
