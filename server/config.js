// Пути и параметры запуска. Данные (книги, база, аудио, модели) лежат вне репозитория.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.BOOKREADER_DATA || 'D:\\bookreader-data');
export const BOOKS_DIR = path.join(DATA_DIR, 'books');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const MODELS_DIR = path.join(DATA_DIR, 'models');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const DB_PATH = path.join(DATA_DIR, 'bookreader.sqlite');
export const DIST_DIR = path.join(ROOT, 'dist');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT) || 5180;

for (const d of [DATA_DIR, BOOKS_DIR, AUDIO_DIR, MODELS_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });
