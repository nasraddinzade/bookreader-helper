// Чтение вслух: сопоставление услышанного с текстом абзаца и подсчёт очков.
// Не зависит от браузера — проверяется тестами в Node.

export const normWord = (w) => String(w || '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^a-z0-9'-]/g, '').replace(/^'+|'+$/g, '');
const stem = (w) => normWord(w).replace(/'(s|d|ll|re|ve|m|t)$/, '').replace(/ies$/, 'y').replace(/(es|s)$/, '');

/** Одно и то же слово с точностью до окончаний: rabbit ≈ rabbits, it ≈ it's. */
export function sameWord(a, b) {
  const x = normWord(a);
  const y = normWord(b);
  if (!x || !y) return false;
  return x === y || stem(x) === stem(y) || x.replace(/-/g, '') === y.replace(/-/g, '');
}

/** Грубый «звуковой ключ» английского слова: похожие согласные сводятся вместе, гласные после первой буквы убираются. */
export function soundKey(word) {
  let w = normWord(word).replace(/[^a-z]/g, '');
  if (!w) return '';
  w = w.replace(/ph/g, 'f').replace(/th/g, 't').replace(/ck/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/v/g, 'f').replace(/b/g, 'p').replace(/d/g, 't')
    .replace(/g/g, 'k').replace(/(?!^)[hwy]/g, '');
  const head = w[0];
  const tail = w.slice(1).replace(/[aeiou]/g, '');
  return (head + tail).replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Похоже ли услышанное на нужное слово (лёгкий акцент, неточное распознавание):
 * то же слово с окончаниями, одинаковое звучание по soundKey или близкое написание (доля совпадения ≥ minSim).
 */
export function similarWord(heard, expected, minSim = 0.6) {
  if (sameWord(heard, expected)) return true;
  const a = normWord(heard).replace(/[^a-z]/g, '');
  const b = normWord(expected).replace(/[^a-z]/g, '');
  if (!a || !b) return false;
  if (b.length >= 3 && soundKey(a) === soundKey(b)) return true;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= minSim;
}

/**
 * Строгость проверки:
 *   threshold  — уверенности «по тексту» хватает, если «свободный» ничего другого не услышал;
 *   similarity — насколько похожим должно быть слово у «свободного», чтобы засчитать (акцент);
 *   veto       — «свободный» услышал другое, непохожее слово: это ошибка, если «по тексту» уверен меньше veto;
 *   earlyStop  — останавливать по промежуточной гипотезе, не дожидаясь проверки.
 */
export const STRICTNESS = {
  soft: { threshold: 0.55, similarity: 0.5, veto: 0.75, earlyStop: false },
  normal: { threshold: 0.7, similarity: 0.6, veto: 0.92, earlyStop: false },
  strict: { threshold: 0.88, similarity: 0.75, veto: 0.98, earlyStop: true },
};

/**
 * Слова абзаца для проверки. sentences: [{ id, text, tokens? }] — токены из перевода (en, gap),
 * если их нет — разбивка по пробелам. Слово помнит, к какому предложению и токену относится,
 * чтобы подсвечивать его в тексте.
 * check = false — слово не проверяется (нет букв или его не знает распознаватель).
 */
export function paragraphWords(sentences) {
  const out = [];
  sentences.forEach((s, si) => {
    const toks = s.tokens?.length ? s.tokens : s.text.split(/\s+/).filter(Boolean).map((en) => ({ en }));
    toks.forEach((t, ti) => {
      // Слова через дефис проверяются по частям: «rabbit-hole» → rabbit, hole (так их знает распознаватель).
      for (const part of String(t.en).split(/[\s—–-]+/)) {
        const w = normWord(part);
        if (!w || !/[a-z]/.test(w)) continue;
        out.push({ w, s: si, sid: s.id, t: ti, check: true });
      }
    });
  });
  return out;
}

// Служебные слова, которые распознаватель часто «проглатывает» при беглом чтении:
// их пропуск не считается ошибкой.
const LIGHT = new Set(('a an the of to and in on at for by as or but is was it its i he she we you they his her my me '
  + 'so not no if be am are were been had has have do did does this that with from all one them then than there their '
  + 'what when out up us our your him who how can could would should will shall just too very much such into onto').split(' '));
// Слова из одной-двух букв акустически слабые — тоже проверяются мягко.
const isLight = (w) => LIGHT.has(w) || w.length <= 2;

export const COMBO_STEP = 10; // каждые 10 верных слов подряд — множитель выше
export const comboMultiplier = (combo) => [1, 1.5, 2, 2.5, 3][Math.min(4, Math.floor(combo / COMBO_STEP))];

/**
 * Следит за чтением. Состояния слов: pending → ok | error → fixed | skipped; auto — не проверялось.
 * threshold — уверенность «по тексту», выше которой слово засчитывается без «свободного».
 */
export class ReadTracker {
  constructor(words, { threshold = STRICTNESS.normal.threshold, similarity = STRICTNESS.normal.similarity, veto = STRICTNESS.normal.veto, earlyStop = false } = {}) {
    this.words = words;
    this.threshold = threshold;
    this.similarity = similarity; // насколько похожим должно быть услышанное «свободным» распознавателем
    this.veto = veto;
    this.earlyStop = earlyStop; // останавливать по промежуточной гипотезе, не дожидаясь проверки
    this.pos = 0;
    this.state = words.map(() => 'pending');
    this.heard = words.map(() => '');
    this.combo = 0;
    this.maxCombo = 0;
    this.points = 0;
    this.free = []; // слова «свободного» распознавателя с временем
    this.paused = false;
    this.unkAt = -1; // где и сколько обновлений подряд промежуточная гипотеза держит [unk]
    this.unkStreak = 0;
  }

  get done() { return this.pos >= this.words.length; }

  /** Слова «свободного» распознавателя копятся и используются для проверки по времени. */
  addFree(result) {
    for (const w of result || []) this.free.push(w);
  }

  /** «Свободный» распознаватель в это время услышал то же или похожее слово (одно или два соседних слитно). */
  heardLike(w, expected) {
    const over = this.overlap(w);
    if (over.some((x) => similarWord(x.word, expected, this.similarity))) return true;
    for (let k = 0; k + 1 < over.length; k++) {
      if (similarWord(over[k].word + over[k + 1].word, expected, this.similarity)) return true; // «rabbit hole» ≈ «rabbithole»
    }
    return false;
  }

  /** Слова «свободного» распознавателя, заметно пересекающиеся по времени со словом w. */
  overlap(w) {
    return this.free.filter((x) => Math.min(x.end, w.end) - Math.max(x.start, w.start) > 0.04);
  }

  ok(i, how = 'ok') {
    this.state[i] = how;
    if (how === 'ok') {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.points += Math.round(10 * comboMultiplier(this.combo - 1));
    }
    this.pos = i + 1;
  }

  error(i, heard = '') {
    this.state[i] = 'error';
    this.heard[i] = heard;
    this.combo = 0;
    this.paused = true;
    return { type: 'error', i, heard };
  }

  /** Не проверяемые слова (их нет в словаре распознавателя) пропускаются автоматически. */
  skipUnchecked() {
    while (!this.done && !this.words[this.pos].check) {
      this.ok(this.pos, 'auto');
      // Слово вне словаря распознавателя всё равно произносится и слышится как [unk] — прощаем один.
      this.absorb = (this.absorb || 0) + 1;
    }
  }

  /**
   * Промежуточная гипотеза текущего отрезка речи (без уверенности): до какого слова дочитали.
   * Возвращает { upTo, unk } — unk: на ожидаемом слове стоит [unk] и после него сказано ещё
   * минимум два слова (значит, читающий не остановился, а слово прочитано неверно).
   */
  partial(text) {
    if (this.paused) return { upTo: this.pos, unk: false };
    const said = String(text || '').split(/\s+/).filter(Boolean);
    let p = this.pos;
    let absorb = this.absorb || 0;
    for (let k = 0; k < said.length && p < this.words.length; k++) {
      while (p < this.words.length && !this.words[p].check) { p++; absorb++; }
      if (p >= this.words.length) break;
      const w = said[k];
      if (w === '[unk]' && absorb > 0) { absorb--; continue; } // это прозвучало слово вне словаря
      if (w === '[unk]') {
        // Служебные слова распознаются ненадёжно — по ним досрочно не останавливаем.
        if (isLight(this.words[p].w)) { p++; continue; }
        const unk = said.length - k - 1 >= 3;
        this.unkStreak = unk && this.unkAt === p ? this.unkStreak + 1 : unk ? 1 : 0;
        this.unkAt = p;
        // Промежуточная гипотеза нестабильна: ошибка, только если [unk] держится 3 обновления подряд.
        return { upTo: p, unk: this.earlyStop && this.unkStreak >= 3 };
      }
      if (sameWord(w, this.words[p].w)) { p++; continue; }
      const ahead = this.findAhead(w, p);
      if (ahead > p) p = ahead + 1;
    }
    return { upTo: p, unk: false };
  }

  findAhead(w, from) {
    for (let j = from + 1; j <= Math.min(this.words.length - 1, from + 3); j++) if (sameWord(w, this.words[j].w)) return j;
    return -1;
  }

  /**
   * Окончательный результат отрезка речи от распознавателя «по тексту».
   * Возвращает события: { type: 'ok' | 'auto', i } и одно { type: 'error', i, heard } в конце, если ошибка.
   */
  final(result) {
    const events = [];
    if (this.paused) return events;
    for (const w of result || []) {
      const gapStart = this.lastEnd; // конец предыдущего слова — для проверки проглоченных слов
      this.lastEnd = w.end;
      this.skipUnchecked();
      if (this.done) break;
      const i = this.pos;
      const exp = this.words[i];
      // Служебные слова распознаются ненадёжно и почти не несут смысла — засчитываем их мягко.
      const light = isLight(exp.w);
      if (w.word === '[unk]') {
        if (this.absorb > 0) { this.absorb--; continue; }
        // [unk] «по тексту», но «свободный» услышал похожее слово — это акцент, а не ошибка.
        if (light || this.heardLike(w, exp.w)) { this.ok(i); events.push({ type: 'ok', i }); continue; }
        events.push(this.error(i, this.overlap(w).map((x) => x.word).join(' ')));
        return events;
      }
      if (sameWord(w.word, exp.w)) {
        // Похожее у «свободного» — засчитано (акцент). Он ясно услышал другое слово — ошибка, если «по тексту»
        // уверен меньше veto (подмена: sing вместо say). Иначе решает уверенность «по тексту».
        const differs = this.overlap(w).length > 0;
        const sure = light || this.heardLike(w, exp.w) || (differs ? w.conf >= this.veto : w.conf >= this.threshold);
        if (!sure) {
          events.push(this.error(i, this.overlap(w).map((x) => x.word).join(' ')));
          return events;
        }
        this.ok(i);
        this.absorb = 0;
        events.push({ type: 'ok', i });
        continue;
      }
      // Распознано другое слово абзаца. Чуть дальше по тексту — значит, слова пропущены.
      const j = this.findAhead(w.word, i);
      if (j > i) {
        // Распознаватель «по тексту» иногда проглатывает слово. Если «свободный» в этом промежутке
        // слышал похожее слово, это не пропуск.
        const gap = { start: gapStart ?? w.start - 1.5, end: w.start };
        const missed = this.words.slice(i, j).findIndex((x) => x.check && !isLight(x.w) && !this.heardLike(gap, x.w));
        if (missed >= 0) {
          events.push(this.error(i + missed, this.overlap(gap).map((x) => x.word).join(' ')));
          return events;
        }
        for (let k = i; k < j; k++) { this.ok(k, 'auto'); events.push({ type: 'auto', i: k }); }
        this.ok(j);
        events.push({ type: 'ok', i: j });
      }
      // Иначе это повтор уже прочитанного или шум — пропускаем.
    }
    this.skipUnchecked();
    return events;
  }

  /** Слово исправлено после подсказки: чтение продолжается со следующего. */
  fixed(i) {
    this.state[i] = 'fixed';
    this.points += 5;
    this.pos = i + 1;
    this.paused = false;
    this.free = [];
    this.lastEnd = undefined; // новый сеанс распознавания — время снова с нуля
    this.skipUnchecked();
  }

  /** Распознавание ошиблось («я прочитал правильно»): слово засчитывается как верное. */
  accept(i) {
    this.state[i] = 'pending';
    this.ok(i);
    this.paused = false;
    this.free = [];
    this.lastEnd = undefined; // новый сеанс распознавания — время снова с нуля
    this.skipUnchecked();
  }

  skipped(i) {
    this.state[i] = 'skipped';
    this.pos = i + 1;
    this.paused = false;
    this.free = [];
    this.lastEnd = undefined; // новый сеанс распознавания — время снова с нуля
    this.skipUnchecked();
  }

  /** Итог абзаца: точность, звёзды и очки (за слова + бонус за звёзды). */
  summary() {
    const checked = this.state.filter((s) => s !== 'auto');
    const ok = this.state.filter((s) => s === 'ok').length;
    const accuracy = checked.length ? ok / checked.length : 1;
    const stars = accuracy >= 0.95 ? 3 : accuracy >= 0.85 ? 2 : 1;
    const bonus = [0, 10, 25, 50][stars];
    return {
      words: this.words.length,
      ok,
      fixed: this.state.filter((s) => s === 'fixed').length,
      skipped: this.state.filter((s) => s === 'skipped').length,
      accuracy,
      stars,
      maxCombo: this.maxCombo,
      wordPoints: this.points,
      bonus,
      points: this.points + bonus,
    };
  }
}

// ---- Уровни ----------------------------------------------------------------------

export const TITLES = [
  [1, 'Ученик'],
  [3, 'Переписчик'],
  [5, 'Книжник'],
  [8, 'Хранитель свитков'],
  [12, 'Летописец'],
  [17, 'Магистр слова'],
  [25, 'Архимаг библиотеки'],
];

/** Опыт, нужный для достижения уровня n (уровень 1 — с нуля): 150, 450, 900, … */
export const xpForLevel = (n) => 75 * (n - 1) * n;

export function levelInfo(xp) {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  const title = [...TITLES].reverse().find(([l]) => level >= l)[1];
  const from = xpForLevel(level);
  const to = xpForLevel(level + 1);
  return { level, title, xp, from, to, progress: (xp - from) / (to - from) };
}
