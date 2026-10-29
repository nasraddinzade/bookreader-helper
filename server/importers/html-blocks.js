// Превращает (X)HTML главы в поток блоков-абзацев: { text, kind: 'p' | 'h' }.
// Попутно запоминает, перед каким блоком встретился каждый id — по ним режется оглавление.

import { parseDocument } from 'htmlparser2';

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'blockquote', 'pre',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th', 'caption', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'body', 'center', 'address', 'poem', 'stanza', 'v',
]);
const SKIP = new Set(['script', 'style', 'head', 'title', 'svg', 'math', 'noscript', 'template', 'rt', 'rp']);
const HEADING = /^h[1-6]$/;

export function cleanText(s) {
  return s
    .replace(/­/g, '') // мягкие переносы
    .replace(/[​-‍﻿]/g, '')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Служебные вставки Project Gutenberg (шапка и лицензия) не переводим. */
function isBoilerplate(el) {
  const id = el.attribs?.id || '';
  const cls = el.attribs?.class || '';
  return /^pg-(header|footer)$/.test(id) || /\bpg-boilerplate\b/.test(cls);
}

/**
 * @returns {{ blocks: {text: string, kind: string}[], anchors: Map<string, number> }}
 *   anchors: id элемента → индекс первого блока после него.
 */
export function htmlToBlocks(html) {
  const doc = parseDocument(html, { decodeEntities: true, recognizeSelfClosing: true, lowerCaseTags: true });
  const blocks = [];
  const anchors = new Map();
  let buf = '';
  let kind = 'p';

  const flush = () => {
    const text = cleanText(buf);
    if (text) blocks.push({ text, kind });
    buf = '';
    kind = 'p';
  };

  const walk = (node, inHeading) => {
    if (node.type === 'text') { buf += node.data; return; }
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style' && node.type !== 'root') return;
    const name = node.name;
    if (name && SKIP.has(name)) return;
    if (node.attribs && isBoilerplate(node)) return;
    if (name === 'br') { if (inHeading && cleanText(buf)) kind = 'h'; flush(); return; }
    if (name === 'img') return;
    const isBlock = name && BLOCK.has(name);
    const isHeading = name && HEADING.test(name);
    if (isBlock) flush();
    const id = node.attribs?.id;
    if (id && !anchors.has(id)) anchors.set(id, blocks.length + (cleanText(buf) ? 1 : 0));
    const h = inHeading || isHeading;
    for (const c of node.children || []) walk(c, h);
    if (isBlock) {
      if (h && cleanText(buf)) kind = 'h';
      flush();
    } else if (h && cleanText(buf)) {
      kind = 'h';
    }
  };
  walk(doc, false);
  flush();
  return { blocks, anchors };
}
