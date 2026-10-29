/** Ключ дедупликации слов и фраз: нижний регистр, без пунктуации, одиночные пробелы. */
export function wordKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
