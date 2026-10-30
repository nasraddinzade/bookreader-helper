// SQLite: книги, главы, предложения с глоссами, кэш переводов, словарь, закладки, настройки.

import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

const MIGRATIONS = [
  `
  CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'en',
    target_lang TEXT NOT NULL DEFAULT 'ru',
    format TEXT NOT NULL,
    file_name TEXT NOT NULL,
    cover TEXT,
    added_at TEXT NOT NULL,
    opened_at TEXT,
    pos_chapter INTEGER NOT NULL DEFAULT 0,
    pos_sentence INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE chapters (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0,
    n_sentences INTEGER NOT NULL DEFAULT 0,
    UNIQUE (book_id, idx)
  );
  CREATE TABLE sentences (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    para INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'p',
    text TEXT NOT NULL,
    hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    gloss TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    translated_by TEXT,
    audio TEXT,
    audio_key TEXT,
    audio_error TEXT
  );
  CREATE INDEX sentences_chapter ON sentences (chapter_id, idx);
  CREATE INDEX sentences_book_status ON sentences (book_id, status);
  CREATE TABLE gloss_cache (
    key TEXT PRIMARY KEY,
    gloss TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE bookmarks (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_idx INTEGER NOT NULL,
    sentence_idx INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE vocab (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    lang TEXT NOT NULL,
    tgt TEXT NOT NULL,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    lemma TEXT NOT NULL DEFAULT '',
    ctx TEXT NOT NULL DEFAULT '',
    base TEXT NOT NULL DEFAULT '',
    pos TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    clean_hit_days TEXT NOT NULL DEFAULT '[]',
    required_days INTEGER NOT NULL DEFAULT 3,
    learned INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    last_miss_at TEXT,
    last_review_at TEXT,
    UNIQUE (kind, lang, key)
  );
  CREATE TABLE examples (
    id INTEGER PRIMARY KEY,
    vocab_id INTEGER NOT NULL REFERENCES vocab(id) ON DELETE CASCADE,
    en TEXT NOT NULL,
    ctx TEXT NOT NULL DEFAULT '',
    sentence TEXT NOT NULL,
    sentence_ru TEXT NOT NULL DEFAULT '',
    book_id INTEGER,
    book_title TEXT NOT NULL DEFAULT '',
    chapter_idx INTEGER,
    chapter_title TEXT NOT NULL DEFAULT '',
    sentence_idx INTEGER,
    added_at TEXT NOT NULL,
    UNIQUE (vocab_id, sentence)
  );
  CREATE TABLE selection_cache (
    key TEXT PRIMARY KEY,
    ru TEXT NOT NULL,
    via TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE audio_cache (
    key TEXT PRIMARY KEY,
    file TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: словарь лемм (значения base запрашиваются один раз на лемму для всех книг);
  //    быстрый режим перевода меняет размер пачки и параллельность по умолчанию.
  `
  CREATE TABLE lemma_dict (
    lang TEXT NOT NULL,
    tgt TEXT NOT NULL,
    lemma TEXT NOT NULL,
    base TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL,
    PRIMARY KEY (lang, tgt, lemma)
  );
  CREATE INDEX lemma_dict_pending ON lemma_dict (base) WHERE base IS NULL;
  DELETE FROM settings WHERE key IN ('batchSize', 'parallel');
  `,
];

{
  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// ---- Настройки ---------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  targetLang: 'ru', // язык перевода для новых книг (хранится и у каждой книги)
  provider: 'claude-code', // claude-code | ollama | stub
  translationPaused: false,
  claudeModel: 'sonnet', // sonnet | haiku | opus
  claudeEffort: 'low',
  glossMode: 'fast', // fast — токены локально, модель даёт только переводы; full — модель размечает всё сама
  dictModel: 'haiku', // модель для словарных значений лемм
  batchSize: 40, // предложений в пачке (в режиме full — до 12)
  parallel: 10, // одновременных запросов к claude -p (замер: ~8000 слов/мин на Sonnet 5.5)
  ollamaModel: 'qwen3:8b',
  ollamaThreads: 6,
  ttsEnabled: true,
  ttsVoice: 'af_heart',
  ttsSpeed: 1,
  ttsThreads: 4,
  ttsDtype: 'fp32', // fp32 на этом CPU быстрее q8
  ttsPaused: false,
  hintMode: 'visible', // visible | hover | off
  ruColumn: 'show', // show | hide | click
};

const getSettingStmt = db.prepare('SELECT key, value FROM settings');
const putSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

export function getSettings() {
  const s = { ...DEFAULT_SETTINGS };
  for (const row of getSettingStmt.all()) {
    try { s[row.key] = JSON.parse(row.value); } catch { /* битое значение — остаётся по умолчанию */ }
  }
  return s;
}

export function updateSettings(patch) {
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      putSettingStmt.run(k, JSON.stringify(v));
    }
  })();
  return getSettings();
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
