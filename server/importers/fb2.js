// FictionBook 2: метаданные из description, главы — секции первого body, обложка из binary.

import JSZip from 'jszip';
import { parseDocument, DomUtils } from 'htmlparser2';
import { cleanText } from './html-blocks.js';

const local = (name) => String(name || '').replace(/^.*:/, '').toLowerCase();
const kids = (el, name) => (el?.children || []).filter((c) => c.type === 'tag' && local(c.name) === name);
const kid = (el, name) => kids(el, name)[0];
const textOf = (el) => (el ? cleanText(DomUtils.textContent(el)) : '');

/** FB2 часто в windows-1251: берём кодировку из XML-заголовка. */
export function decodeFb2(buf) {
  const head = buf.subarray(0, 200).toString('latin1');
  const enc = (head.match(/encoding=["']([\w-]+)["']/i)?.[1] || 'utf-8').toLowerCase();
  try { return new TextDecoder(enc).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

// Блоки секции: p, v (строки стихов), subtitle, text-author; заголовок секции — kind 'h'.
function sectionBlocks(section) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children || []) {
      if (c.type !== 'tag') continue;
      const n = local(c.name);
      if (n === 'section') continue; // вложенные секции — отдельные главы
      if (n === 'title') { for (const p of DomUtils.findAll((e) => local(e.name) === 'p', c.children)) { const t = textOf(p); if (t) out.push({ text: t, kind: 'h' }); } continue; }
      if (n === 'p' || n === 'v' || n === 'subtitle' || n === 'text-author') { const t = textOf(c); if (t) out.push({ text: t, kind: n === 'subtitle' ? 'h' : 'p' }); continue; }
      if (n === 'image' || n === 'binary') continue;
      walk(c); // poem, stanza, epigraph, cite, table…
    }
  };
  walk(section);
  return out;
}

export async function parseFb2(buffer) {
  let buf = buffer;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    // .fb2.zip
    const zip = await JSZip.loadAsync(buf);
    const name = Object.keys(zip.files).find((k) => /\.fb2$/i.test(k));
    if (!name) throw new Error('В архиве нет .fb2');
    buf = await zip.file(name).async('nodebuffer');
  }
  const doc = parseDocument(decodeFb2(buf), { xmlMode: true, decodeEntities: true });
  const fb = DomUtils.findOne((e) => local(e.name) === 'fictionbook', doc.children, true);
  if (!fb) throw new Error('Это не FB2: нет элемента FictionBook');

  const info = kid(kid(fb, 'description'), 'title-info');
  const title = textOf(kid(info, 'book-title')) || 'Без названия';
  const author = kids(info, 'author')
    .map((a) => ['first-name', 'middle-name', 'last-name'].map((n) => textOf(kid(a, n))).filter(Boolean).join(' ') || textOf(kid(a, 'nickname')))
    .filter(Boolean).join(', ');
  const lang = (textOf(kid(info, 'lang')) || 'en').toLowerCase().split(/[-_]/)[0];

  const bodies = kids(fb, 'body');
  const body = bodies.find((b) => !b.attribs?.name) || bodies[0];
  const chapters = [];
  const walk = (section, level) => {
    const blocks = sectionBlocks(section);
    const subs = kids(section, 'section');
    const titleText = textOf(kid(section, 'title')) || '';
    if (blocks.some((b) => b.kind === 'p') || !subs.length) {
      if (blocks.length) chapters.push({ title: titleText || `Глава ${chapters.length + 1}`, level, blocks });
    }
    for (const s of subs) walk(s, level + 1);
  };
  if (body) {
    const pre = sectionBlocks(body); // заголовок и эпиграф книги вне секций
    if (pre.length) chapters.push({ title: 'Начало', level: 0, blocks: pre });
    for (const s of kids(body, 'section')) walk(s, 0);
  }

  let cover = null;
  const img = DomUtils.findOne((e) => local(e.name) === 'image', kid(info, 'coverpage')?.children || [], true);
  const href = img && (img.attribs['l:href'] || img.attribs['xlink:href'] || Object.entries(img.attribs).find(([k]) => /href$/.test(k))?.[1]);
  if (href) {
    const bin = kids(fb, 'binary').find((b) => b.attribs.id === href.replace(/^#/, ''));
    if (bin) {
      const type = bin.attribs['content-type'] || 'image/jpeg';
      cover = { data: Buffer.from(DomUtils.textContent(bin).replace(/\s+/g, ''), 'base64'), ext: type.includes('png') ? '.png' : '.jpg' };
    }
  }
  return { title, author, lang, chapters, cover };
}
