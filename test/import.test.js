import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFb2 } from '../server/importers/fb2.js';
import { parseTxt } from '../server/importers/txt.js';
import { htmlToBlocks } from '../server/importers/html-blocks.js';

const FB2 = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><author><first-name>Lewis</first-name><last-name>Carroll</last-name></author>
<book-title>Alice — test</book-title><lang>en</lang></title-info></description>
<body><title><p>Alice</p></title>
<section><title><p>Chapter I</p></title><p>Alice was tired. She met Mr. Rabbit.</p><p>“Oh dear!”</p></section>
<section><title><p>Chapter II</p></title><poem><stanza><v>How doth the little crocodile</v><v>Improve his shining tail</v></stanza></poem></section>
</body>
<body name="notes"><section id="n1"><p>Note</p></section></body>
</FictionBook>`;

test('fb2: windows-1251, главы по секциям, стихи построчно, примечания не попадают', async () => {
  const enc = new Map([['—', 0x97], ['“', 0x93], ['”', 0x94]]);
  const buf = Buffer.from([...FB2].map((ch) => enc.get(ch) ?? ch.charCodeAt(0)));
  const b = await parseFb2(buf);
  assert.equal(b.title, 'Alice — test');
  assert.equal(b.author, 'Lewis Carroll');
  assert.equal(b.lang, 'en');
  assert.deepEqual(b.chapters.map((c) => c.title), ['Начало', 'Chapter I', 'Chapter II']);
  assert.deepEqual(b.chapters[1].blocks.map((x) => x.text), ['Chapter I', 'Alice was tired. She met Mr. Rabbit.', '“Oh dear!”']);
  assert.equal(b.chapters[2].blocks.length, 3);
});

test('txt: шапка Gutenberg отрезается, главы по CHAPTER', () => {
  const t = 'Title: Book\nAuthor: Someone\n\n*** START OF THE PROJECT GUTENBERG EBOOK BOOK ***\n\nCHAPTER I.\n\nFirst para\nwrapped line.\n\nSecond.\n\nCHAPTER II.\n\nThird.\n\n*** END OF THE PROJECT GUTENBERG EBOOK BOOK ***\nlicense';
  const b = parseTxt(Buffer.from(t), 'book.txt');
  assert.equal(b.title, 'Book');
  assert.equal(b.author, 'Someone');
  assert.deepEqual(b.chapters.map((c) => c.title), ['CHAPTER I.', 'CHAPTER II.']);
  assert.equal(b.chapters[0].blocks[1].text, 'First para wrapped line.');
});

test('html: заголовки, br, якоря, шапка Gutenberg пропускается', () => {
  const { blocks, anchors } = htmlToBlocks('<body><section id="pg-header"><p>License</p></section><h2><a id="c1"></a>CHAPTER I.<br/>Down</h2><p>Text <i>here</i>.</p></body>');
  assert.deepEqual(blocks, [{ text: 'CHAPTER I.', kind: 'h' }, { text: 'Down', kind: 'h' }, { text: 'Text here.', kind: 'p' }]);
  assert.equal(anchors.get('c1'), 0);
});
