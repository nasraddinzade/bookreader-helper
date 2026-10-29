// EPUB 2/3: метаданные из OPF, порядок из spine, главы по оглавлению (nav или NCX).

import JSZip from 'jszip';
import path from 'node:path';
import { parseDocument, DomUtils } from 'htmlparser2';
import { htmlToBlocks, cleanText } from './html-blocks.js';

const xml = (s) => parseDocument(s, { xmlMode: true, decodeEntities: true });
const local = (name) => String(name || '').replace(/^.*:/, '').toLowerCase();
const find = (root, name) => DomUtils.findOne((e) => local(e.name) === name, root.children || [root], true);
const findAll = (root, name) => DomUtils.findAll((e) => local(e.name) === name, root.children || [root]);
const textOf = (el) => (el ? cleanText(DomUtils.textContent(el)) : '');

function resolve(base, href) {
  const [p, frag] = String(href).split('#');
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(base), decodeURIComponent(p)));
  return { file, frag: frag ? decodeURIComponent(frag) : '' };
}

async function readText(zip, file) {
  const f = zip.file(file) || zip.file(Object.keys(zip.files).find((k) => k.toLowerCase() === file.toLowerCase()) || '');
  if (!f) return null;
  return f.async('string');
}

function parseNav(navHtml, navPath) {
  const doc = parseDocument(navHtml, { decodeEntities: true, recognizeSelfClosing: true });
  const navs = DomUtils.findAll((e) => e.name === 'nav', doc.children);
  const toc = navs.find((n) => /\btoc\b/.test(n.attribs['epub:type'] || n.attribs.role || '')) || navs[0];
  if (!toc) return [];
  const out = [];
  const walkOl = (ol, level) => {
    for (const li of (ol.children || []).filter((c) => c.name === 'li')) {
      const a = (li.children || []).find((c) => c.name === 'a' || c.name === 'span');
      if (a?.name === 'a' && a.attribs.href) out.push({ title: textOf(a), level, ...resolve(navPath, a.attribs.href) });
      const sub = (li.children || []).find((c) => c.name === 'ol' || c.name === 'ul');
      if (sub) walkOl(sub, level + 1);
    }
  };
  const ol = DomUtils.findOne((e) => e.name === 'ol' || e.name === 'ul', toc.children, true);
  if (ol) walkOl(ol, 0);
  return out;
}

function parseNcx(ncxXml, ncxPath) {
  const doc = xml(ncxXml);
  const navMap = find(doc, 'navmap');
  if (!navMap) return [];
  const out = [];
  const walk = (el, level) => {
    for (const np of (el.children || []).filter((c) => local(c.name) === 'navpoint')) {
      const label = find(np, 'navlabel');
      const content = (np.children || []).find((c) => local(c.name) === 'content');
      if (content?.attribs?.src) out.push({ title: textOf(label), level, ...resolve(ncxPath, content.attribs.src) });
      walk(np, level + 1);
    }
  };
  walk(navMap, 0);
  return out;
}

export async function parseEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = await readText(zip, 'META-INF/container.xml');
  if (!container) throw new Error('Это не EPUB: нет META-INF/container.xml');
  const rootfile = find(xml(container), 'rootfile');
  const opfPath = rootfile?.attribs?.['full-path'];
  if (!opfPath) throw new Error('В EPUB не найден OPF-файл');
  const opf = xml(await readText(zip, opfPath));

  const meta = find(opf, 'metadata');
  const title = textOf(meta && find(meta, 'title')) || 'Без названия';
  const author = (meta ? findAll(meta, 'creator') : []).map(textOf).filter(Boolean).join(', ');
  const lang = (textOf(meta && find(meta, 'language')) || 'en').toLowerCase().split(/[-_]/)[0];

  const manifest = new Map();
  for (const it of findAll(opf, 'item')) {
    const a = it.attribs;
    manifest.set(a.id, { id: a.id, href: a.href, file: resolve(opfPath, a.href).file, type: a['media-type'] || '', props: a.properties || '' });
  }
  const spineEl = find(opf, 'spine');
  const spine = (spineEl ? findAll(spineEl, 'itemref') : [])
    .filter((r) => r.attribs.linear !== 'no')
    .map((r) => manifest.get(r.attribs.idref))
    .filter((m) => m && /html|xml/.test(m.type));

  // Оглавление: EPUB3 nav, иначе NCX.
  let toc = [];
  const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.props));
  if (navItem) toc = parseNav(await readText(zip, navItem.file) || '', navItem.file);
  if (!toc.length) {
    const ncxItem = manifest.get(spineEl?.attribs?.toc) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    if (ncxItem) toc = parseNcx(await readText(zip, ncxItem.file) || '', ncxItem.file);
  }

  // Поток блоков всей книги в порядке spine и позиции якорей в нём.
  const blocks = [];
  const positions = new Map(); // "file#id" и "file" → индекс блока
  for (const item of spine) {
    const html = await readText(zip, item.file);
    if (html == null) continue;
    const { blocks: b, anchors } = htmlToBlocks(html);
    positions.set(item.file, blocks.length);
    for (const [id, i] of anchors) positions.set(`${item.file}#${id}`, blocks.length + i);
    blocks.push(...b);
  }

  // Точки разреза: элементы оглавления, найденные в потоке, по возрастанию позиции.
  const cuts = [];
  for (const t of toc) {
    const at = positions.get(t.frag ? `${t.file}#${t.frag}` : t.file) ?? positions.get(t.file);
    if (at === undefined) continue;
    const prev = cuts[cuts.length - 1];
    if (prev && at < prev.at) continue; // оглавление не по порядку книги — пропускаем
    if (prev && at === prev.at) { if (t.level >= prev.level) Object.assign(prev, { title: t.title || prev.title, level: t.level }); continue; }
    cuts.push({ at, title: t.title, level: t.level });
  }

  let chapters = [];
  if (!cuts.length) {
    // Оглавления нет: глава на каждый файл spine.
    const starts = spine.map((s) => positions.get(s.file)).filter((x) => x !== undefined);
    starts.forEach((at, k) => {
      const part = blocks.slice(at, starts[k + 1] ?? blocks.length);
      if (part.length) chapters.push({ title: part.find((b) => b.kind === 'h')?.text || `Часть ${chapters.length + 1}`, level: 0, blocks: part });
    });
  } else {
    if (cuts[0].at > 0) {
      const pre = blocks.slice(0, cuts[0].at);
      if (pre.length) chapters.push({ title: 'Начало', level: 0, blocks: pre });
    }
    cuts.forEach((c, k) => {
      const part = blocks.slice(c.at, cuts[k + 1]?.at ?? blocks.length);
      if (part.length) chapters.push({ title: c.title || `Глава ${k + 1}`, level: c.level, blocks: part });
    });
  }
  chapters = chapters.filter((c) => c.blocks.some((b) => /\p{L}/u.test(b.text)));

  // Обложка: properties="cover-image", <meta name="cover">, иначе картинка с cover в имени.
  let cover = null;
  const metaCover = findAll(opf, 'meta').find((m) => m.attribs.name === 'cover')?.attribs.content;
  const coverItem = [...manifest.values()].find((m) => /cover-image/.test(m.props))
    || manifest.get(metaCover)
    || [...manifest.values()].find((m) => /^image\//.test(m.type) && /cover/i.test(m.id + m.href));
  if (coverItem && /^image\//.test(coverItem.type)) {
    const f = zip.file(coverItem.file);
    if (f) cover = { data: await f.async('nodebuffer'), ext: path.extname(coverItem.file).toLowerCase() || '.jpg' };
  }

  return { title, author, lang, chapters, cover };
}
