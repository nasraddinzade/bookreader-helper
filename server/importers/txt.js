// TXT: абзацы по пустым строкам, главы по строкам «Chapter I», «CHAPTER 2.», «Part One»…
// Шапка и лицензия Project Gutenberg отрезаются.

const CHAPTER_RE = /^(chapter|book|part|section|глава|часть)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[a-z]+teen|twenty[- a-z]*|thirty[- a-z]*)\b.{0,80}$/i;
const PARAS_PER_PART = 120;

function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('windows-1252').decode(buf); }
}

export function parseTxt(buffer, fileName = '') {
  let text = decode(buffer).replace(/\r\n?/g, '\n');
  let title = '';
  let author = '';
  let lang = 'en';
  const start = text.match(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*$/m);
  if (start) {
    const head = text.slice(0, start.index);
    title = head.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || '';
    author = head.match(/^Author:\s*(.+)$/m)?.[1]?.trim() || '';
    const l = head.match(/^Language:\s*(.+)$/m)?.[1]?.trim().toLowerCase() || '';
    if (l.startsWith('english')) lang = 'en';
    text = text.slice(start.index + start[0].length);
  }
  const end = text.match(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG.*$/m);
  if (end) text = text.slice(0, end.index);

  // Абзацы: по пустым строкам; если пустых строк почти нет — каждая строка отдельный абзац.
  const blankSplit = text.split(/\n[ \t]*\n+/);
  const rawParas = blankSplit.length > 3 ? blankSplit : text.split('\n');
  const paras = rawParas.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!title) title = (fileName.replace(/\.[^.]+$/, '') || paras[0] || 'Без названия').slice(0, 120);

  const chapters = [];
  let cur = { title: 'Начало', level: 0, blocks: [] };
  for (const p of paras) {
    if (CHAPTER_RE.test(p) && p.length < 90) {
      if (cur.blocks.length) chapters.push(cur);
      cur = { title: p, level: 0, blocks: [{ text: p, kind: 'h' }] };
      continue;
    }
    cur.blocks.push({ text: p, kind: 'p' });
  }
  if (cur.blocks.length) chapters.push(cur);

  // Глав не нашлось — режем на части фиксированного размера, чтобы глава открывалась быстро.
  if (chapters.length === 1 && chapters[0].blocks.length > PARAS_PER_PART) {
    const all = chapters[0].blocks;
    chapters.length = 0;
    for (let i = 0; i < all.length; i += PARAS_PER_PART) {
      chapters.push({ title: `Часть ${chapters.length + 1}`, level: 0, blocks: all.slice(i, i + PARAS_PER_PART) });
    }
  }
  return { title, author, lang, chapters, cover: null };
}
