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

test('parseJsonResponse: неэкранированные кавычки в переводе чинятся', async () => {
  const { parseJsonResponse } = await import('../server/providers/prompt.js');
  const raw = '{"sentences":[{"full":"Она сказала: "Ой!" и убежала.","tokens":[{"en":"“Oh!”","ctx":"ой","lemma":"oh","base":"ой","pos":"interj"}]}]}';
  const j = parseJsonResponse(raw);
  assert.equal(j.sentences[0].tokens[0].en, '“Oh!”');
  assert.match(j.sentences[0].full, /Ой!/);
});

test('mergeSplitUnits: разорванная идиома склеивается, текст не меняется', async () => {
  const { mergeSplitUnits } = await import('../server/gloss.js');
  const s = '“I wonder how many miles I’ve fallen,” and went on, at once.';
  const toks = [
    { en: '“I', gap: '', ctx: '«Интересно,', lemma: 'I wonder', base: 'интересно', pos: 'idiom' },
    { en: 'wonder', gap: ' ', ctx: '–', lemma: 'wonder', base: '', pos: 'verb' },
    { en: 'how', gap: ' ', ctx: 'сколько', lemma: 'how', base: '', pos: 'adv' },
    { en: 'many', gap: ' ', ctx: '–', lemma: 'many', base: '', pos: 'adj' },
    { en: 'miles', gap: ' ', ctx: 'миль', lemma: 'mile', base: '', pos: 'noun' },
    { en: 'I’ve', gap: ' ', ctx: 'я', lemma: 'I have', base: '', pos: 'pron+aux' },
    { en: 'fallen,”', gap: ' ', ctx: 'упал', lemma: 'fall', base: '', pos: 'verb' },
    { en: 'and', gap: ' ', ctx: 'и', lemma: 'and', base: '', pos: 'conj' },
    { en: 'went', gap: ' ', ctx: 'продолжала', lemma: 'go on', base: 'продолжать', pos: 'verb' },
    { en: 'on,', gap: ' ', ctx: '–', lemma: 'on', base: '', pos: 'particle' },
    { en: 'at', gap: ' ', ctx: '–', lemma: 'at once', base: 'сразу', pos: 'prep' },
    { en: 'once.', gap: ' ', ctx: 'сразу', lemma: 'once', base: '', pos: 'adv' },
  ];
  const m = mergeSplitUnits(toks);
  assert.equal(joinTokens(m), s);
  assert.equal(m[0].en, '“I wonder');
  assert.equal(m[0].ctx, '«Интересно,');
  assert.equal(m.find((t) => t.en === 'went on,').ctx, 'продолжала');
  assert.equal(m.find((t) => t.en === 'at once.').ctx, 'сразу');
  assert.equal(m.find((t) => t.en === 'I’ve').en, 'I’ve'); // «I have» — не идиома через соседей
});
