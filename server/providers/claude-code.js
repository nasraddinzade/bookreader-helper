// Перевод через Claude Code в headless-режиме (claude -p) по подписке пользователя.
// Без --bare (он отключает вход по подписке), без инструментов и MCP, без сохранения сессий.
// Из окружения дочернего процесса убираются ANTHROPIC_API_KEY и прочие переменные, которые
// переключили бы CLI на платный API или на чужой сеанс.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { systemPromptFor, buildUserMessage, parseJsonResponse, extractSentences } from './prompt.js';
import { fastSystemPrompt, buildFastMessage, parseFast, dictSystemPrompt, buildDictMessage, parseDict } from './prompt-fast.js';
import { mapUnits, toUnits } from '../gloss-fast.js';
import { ProviderError, limitError, authError, unavailableError } from './errors.js';

const WORK_DIR = path.join(DATA_DIR, 'claude-work');
// Ответ читается потоком (stream-json): процесс убивается, только если он долго молчит,
// а не по общему времени — большая пачка честно генерируется несколько минут.
const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
const HARD_TIMEOUT_MS = 20 * 60 * 1000;
fs.mkdirSync(WORK_DIR, { recursive: true });

const active = new Set();

// Расход подписки по последнему событию rate_limit_event от CLI: { type, utilization, resetsAt, status }.
let usage = null;
function noteRateLimit(info) {
  usage = {
    type: info.rateLimitType || '',
    utilization: typeof info.utilization === 'number' ? info.utilization : null,
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
    status: info.status || '',
    at: Date.now(),
  };
}
export function subscriptionUsage() {
  return usage;
}
export function killAllClaude() {
  for (const child of active) { try { child.kill(); } catch { /* уже завершён */ } }
}

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(k)) delete env[k];
    else if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|USE_LOCAL_OAUTH|USE_STAGING_OAUTH)$/i.test(k)) delete env[k];
  }
  // Без размышлений: глоссированию они не нужны, а съедают ~3/4 выходных токенов и времени
  // (замер: 2 длинных предложения — 13 847 токенов и 127 с с thinking, 3 582 и 36 с без).
  env.MAX_THINKING_TOKENS = '0';
  return env;
}

function promptFile(name, text) {
  const file = path.join(WORK_DIR, `${name}.txt`);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  return file;
}

/** Время сброса лимита из сообщения CLI: «…|1730000000» или «resets 3pm», иначе через 30 минут. */
function parseResetAt(msg) {
  const epoch = msg.match(/\|(\d{10})\b/);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = msg.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/pm/i.test(m[3] || '')) h += 12;
    if (!m[3] && Number(m[1]) >= 12) h = Number(m[1]);
    const d = new Date();
    d.setHours(h, Number(m[2] || 0), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime() + 60 * 1000;
  }
  return Date.now() + 30 * 60 * 1000;
}

function classify(message) {
  const msg = String(message || '');
  if (/usage limit|limit reached|hit your limit|weekly limit|session limit|quota|resets? (at )?\d/i.test(msg)) {
    return limitError('Достигнут лимит подписки Claude: ' + msg.slice(0, 200), parseResetAt(msg));
  }
  // Кратковременное ограничение частоты (много параллельных запросов): подождать и повторить,
  // не ставя очередь на долгую паузу.
  if (/rate.?limit|429|too many requests/i.test(msg)) {
    return new ProviderError('Claude просит снизить частоту запросов: ' + msg.slice(0, 160), { kind: 'busy', retryable: true });
  }
  if (/authenticat|401|oauth|log ?in|not logged|invalid api key|credentials/i.test(msg)) {
    return authError('Claude Code не авторизован. Выполните в терминале: claude auth login (' + msg.slice(0, 160) + ')');
  }
  if (/overloaded|529|5\d\d|timeout|ECONNRESET|network|fetch failed/i.test(msg)) {
    return new ProviderError('Временная ошибка Claude: ' + msg.slice(0, 200), { retryable: true });
  }
  return new ProviderError('Ошибка Claude Code: ' + msg.slice(0, 300), { retryable: true });
}

/**
 * Запускает claude -p с --output-format stream-json и возвращает итоговое событие result
 * ({ is_error, subtype, result, usage }).
 */
function runClaude(args, input, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('claude', [...args, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
        { cwd: WORK_DIR, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(unavailableError('Не найден Claude Code CLI (claude): ' + e.message));
      return;
    }
    active.add(child);
    let buf = '';
    let err = '';
    let result = null;
    let lastLine = '';
    let killedFor = '';
    let idle = null;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { killedFor = 'нет ответа 3 минуты'; child.kill(); }, IDLE_TIMEOUT_MS);
    };
    kick();
    const hard = setTimeout(() => { killedFor = 'ответ дольше 20 минут'; child.kill(); }, HARD_TIMEOUT_MS);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Порядок ключей в событиях меняется от версии к версии CLI, поэтому тип проверяется после разбора.
    const takeLine = (line) => {
      if (!line) return;
      lastLine = line;
      if (!line.includes('"result"') && !line.includes('"rate_limit_event"')) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'result') result = ev;
      else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) noteRateLimit(ev.rate_limit_info);
    };
    child.stdout.on('data', (d) => {
      kick();
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        takeLine(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    const done = () => { clearTimeout(idle); clearTimeout(hard); active.delete(child); signal?.removeEventListener('abort', onAbort); };
    child.on('error', (e) => {
      done();
      reject(e.code === 'ENOENT' ? unavailableError('Не найден Claude Code CLI (claude) в PATH') : classify(e.message));
    });
    child.on('close', (code) => {
      done();
      if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      takeLine(buf.trim());
      if (!result) {
        reject(killedFor
          ? new ProviderError('Claude Code остановлен: ' + killedFor, { retryable: true, reduceBatch: true })
          : classify(err || lastLine || `claude завершился с кодом ${code}`));
        return;
      }
      resolve(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const baseArgs = (model, file, effort) => {
  const args = [
    '-p',
    '--model', model,
    '--no-session-persistence',
    '--system-prompt-file', file,
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--setting-sources', '',
  ];
  if (effort) args.push('--effort', effort);
  return args;
};

async function call(args, userMessage, signal) {
  const j = await runClaude(args, userMessage, signal);
  if (j.is_error || j.subtype !== 'success') throw classify(j.result || j.error || j.subtype);
  if (typeof j.result !== 'string' || !j.result.trim()) throw new ProviderError('Пустой ответ Claude', { retryable: true });
  return j;
}

const notJson = (e, n) => new ProviderError('Ответ Claude не JSON (возможно, обрезан): ' + e.message, { retryable: true, reduceBatch: n > 1 });

/**
 * Быстрый режим: сопоставляет элементы ответа с предложениями по словам, а не по позиции
 * (модель может пропустить предложение). Для каждого предложения берётся элемент рядом
 * с ожидаемым номером, у которого больше всего слов нашлось в предложении.
 */
function matchFast(texts, items, src, tgt) {
  const used = new Set();
  return texts.map((text, i) => {
    let best = null;
    for (let j = Math.max(0, i - 3); j <= Math.min(items.length - 1, i + 3); j++) {
      if (used.has(j) || !items[j]?.g) continue;
      const m = mapUnits(text, toUnits(items[j].g), src, tgt);
      if (!best || m.coverage > best.m.coverage) best = { j, m };
      if (m.coverage === 1) break;
    }
    if (!best) return null;
    used.add(best.j);
    return { full: items[best.j].f, tokens: best.m.tokens, coverage: best.m.coverage, fast: true };
  });
}

const MIN_COVERAGE = 0.7; // ниже — предложение переспрашивается отдельно

export function claudeCodeProvider({ model = 'sonnet', effort = 'low', mode = 'fast', src = 'en', tgt = 'ru' } = {}) {
  if (mode === 'full') {
    const args = baseArgs(model, promptFile(`gloss-${src}-${tgt}`, systemPromptFor(src, tgt)), effort);
    return {
      id: 'claude-code',
      name: `claude-code:${model}`,
      model,
      maxBatch: 12,
      async glossBatch(texts, { signal } = {}) {
        const j = await call(args, buildUserMessage(texts), signal);
        let parsed;
        try { parsed = parseJsonResponse(j.result); } catch (e) { throw notJson(e, texts.length); }
        return extractSentences(parsed, texts.length);
      },
    };
  }

  const args = baseArgs(model, promptFile(`gloss-fast-${src}-${tgt}`, fastSystemPrompt(src, tgt)), effort);
  return {
    id: 'claude-code',
    name: `claude-code:${model}:fast`,
    model,
    fast: true, // словарные значения (base) заполняются отдельно, через словарь лемм
    maxBatch: 60,
    async glossBatch(texts, { signal } = {}) {
      const j = await call(args, buildFastMessage(texts), signal);
      let items;
      try { items = parseFast(j.result); } catch (e) { throw notJson(e, texts.length); }
      const matched = matchFast(texts, items, src, tgt);
      // Одно предложение — отдаём как есть; в пачке слабые совпадения уходят на повтор по одному.
      return matched.filter((m) => m && (texts.length === 1 || m.coverage >= MIN_COVERAGE));
    },
  };
}

/** Словарные значения лемм: { lemma: 'значение, значение' }. */
export async function claudeDictionary(lemmas, { model = 'haiku', src = 'en', tgt = 'ru', signal } = {}) {
  const args = baseArgs(model, promptFile(`dict-${src}-${tgt}`, dictSystemPrompt(src, tgt)), 'low');
  const j = await call(args, buildDictMessage(lemmas), signal);
  try { return parseDict(j.result); } catch (e) { throw notJson(e, lemmas.length); }
}

/** Короткий текстовый запрос (перевод выделения, если нет Ollama и встроенного переводчика браузера). */
export async function claudeText(prompt, { model = 'haiku', system = 'You are a precise English→Russian translator. Reply with the translation only.' } = {}) {
  const args = ['-p', '--model', model, '--no-session-persistence', '--system-prompt', system,
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--effort', 'low'];
  const j = await runClaude(args, prompt);
  if (j.is_error) throw classify(j.result);
  return String(j.result || '').trim();
}
