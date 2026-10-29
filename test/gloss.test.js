import test from 'node:test';
import assert from 'node:assert/strict';
import { repairTokens, matchResults, finalize } from '../server/gloss.js';
import { joinTokens } from '../shared/align.js';
import { splitIntoSentences } from '../shared/segment.js';

const S = '“Oh dear! I shall be late!” said the Rabbit — and ran off.';

test('repair: пропущенный и лишний токен, кавычки', () => {
  const toks = [{ en: '"Oh', ctx: 'о' }, { en: 'dear!', ctx: 'боже' }, { en: 'I', ctx: 'я' }, { en: 'will', ctx: 'лишнее' }, { en: 'be late!"', ctx: 'опоздаю' }, { en: 'said', ctx: 'сказал' }, { en: 'Rabbit', ctx: 'Кролик' }, { en: 'ran off', ctx: 'убежал' }];
  const r = repairTokens(S, toks);
  assert.equal(joinTokens(r), S);
  assert.ok(r.find((t) => t.ctx === 'убежал').en === 'ran off.');
});

test('repair: пустой ответ даёт слова без перевода', () => {
  assert.equal(joinTokens(repairTokens(S, [])), S);
});

test('match: по выравниванию, а не по позиции', () => {
  const a = 'I went home.', b = 'She found out.';
  const g = [{ full: 'Она узнала.', tokens: [{ en: 'She' }, { en: 'found out.' }] }, { full: 'Я пошёл домой.', tokens: [{ en: 'I' }, { en: 'went' }, { en: 'home.' }] }];
  const m = matchResults([a, b], g);
  assert.equal(m[0].full, 'Я пошёл домой.');
  assert.equal(m[1].full, 'Она узнала.');
  assert.ok(finalize(a, m[0]).aligned);
});

test('segment: Mr., e.g. и —Mr. не режут предложение', () => {
  const { sentences } = splitIntoSentences('He met Mr. Smith, e.g. on Monday. It was Hosmer—Mr. Angel. Then he left.');
  assert.deepEqual(sentences, ['He met Mr. Smith, e.g. on Monday.', 'It was Hosmer—Mr. Angel.', 'Then he left.']);
});
