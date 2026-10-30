// Достаёт словарь (таблицу символов OpenFst) из Gr.fst модели Vosk.
import fs from 'node:fs';
const b = fs.readFileSync(process.argv[2]);
const MAGIC = 2125658996;
let pos = -1;
for (let i = 0; i < b.length - 4; i++) if (b.readInt32LE(i) === MAGIC) { pos = i; break; }
if (pos < 0) throw new Error('symbol table not found');
let p = pos + 4;
const str = () => { const n = b.readInt32LE(p); p += 4; const s = b.toString('utf8', p, p + n); p += n; return s; };
const name = str();
p += 8; // available key
const size = Number(b.readBigInt64LE(p)); p += 8;
const words = [];
for (let i = 0; i < size; i++) { const s = str(); p += 8; words.push(s); }
console.error('table', name, 'size', size, 'sample', words.slice(0, 5), words.slice(-3));
fs.writeFileSync(process.argv[3], words.filter((w) => !/^(<eps>|#|<s>|<\/s>|\[)/.test(w)).join('\n'));
