// Перевод через Claude Code в headless-режиме (claude -p) по подписке пользователя.
// Без --bare (он отключает вход по подписке), без инструментов и MCP, без сохранения сессий.
// Из окружения дочернего процесса убираются ANTHROPIC_API_KEY и прочие переменные, которые
// переключили бы CLI на платный API или на чужой сеанс.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { systemPromptFor, buildUserMessage, parseJsonResponse, extractSentences } from './prompt.js';
import { ProviderError, limitError, authError, unavailableError } from './errors.js';

const WORK_DIR = path.join(DATA_DIR, 'claude-work');
const CALL_TIMEOUT_MS = 6 * 60 * 1000;
fs.mkdirSync(WORK_DIR, { recursive: true });

const active = new Set();
export function killAllClaude() {
  for (const child of active) { try { child.kill(); } catch { /* уже завершён */ } }
}

export function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/i.test(k)) delete env[k];
    else if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|USE_LOCAL_OAUTH|USE_STAGING_OAUTH)$/i.test(k)) delete env[k];
  }
  return env;
}

function promptFile(src, tgt) {
  const file = path.join(WORK_DIR, `gloss-${src}-${tgt}.txt`);
  const text = systemPromptFor(src, tgt);
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
  if (/usage limit|limit reached|rate.?limit|429|quota|too many requests|hit your limit|weekly limit|session limit/i.test(msg)) {
    return limitError('Достигнут лимит подписки Claude: ' + msg.slice(0, 200), parseResetAt(msg));
  }
  if (/authenticat|401|oauth|log ?in|not logged|invalid api key|credentials/i.test(msg)) {
    return authError('Claude Code не авторизован. Выполните в терминале: claude auth login (' + msg.slice(0, 160) + ')');
  }
  if (/overloaded|529|5\d\d|timeout|ECONNRESET|network|fetch failed/i.test(msg)) {
    return new ProviderError('Временная ошибка Claude: ' + msg.slice(0, 200), { retryable: true });
  }
  return new ProviderError('Ошибка Claude Code: ' + msg.slice(0, 300), { retryable: true });
}

function runClaude(args, input, signal) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('claude', args, { cwd: WORK_DIR, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(unavailableError('Не найден Claude Code CLI (claude): ' + e.message));
      return;
    }
    active.add(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      active.delete(child);
      reject(e.code === 'ENOENT' ? unavailableError('Не найден Claude Code CLI (claude) в PATH') : classify(e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      active.delete(child);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
      resolve({ code, out, err });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function claudeCodeProvider({ model = 'sonnet', effort = 'low', src = 'en', tgt = 'ru' } = {}) {
  const file = promptFile(src, tgt);
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--no-session-persistence',
    '--system-prompt-file', file,
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--setting-sources', '',
  ];
  if (effort) args.push('--effort', effort);

  async function call(userMessage, signal) {
    const { code, out, err } = await runClaude(args, userMessage, signal);
    let j = null;
    try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || ''); } catch { /* не JSON */ }
    if (!j) throw classify(err || out || `claude завершился с кодом ${code}`);
    if (j.is_error || j.subtype !== 'success') throw classify(j.result || j.error || j.subtype || err);
    if (typeof j.result !== 'string' || !j.result.trim()) throw new ProviderError('Пустой ответ Claude', { retryable: true });
    return j;
  }

  return {
    id: 'claude-code',
    name: `claude-code:${model}`,
    model,
    async glossBatch(texts, { signal } = {}) {
      const j = await call(buildUserMessage(texts), signal);
      let parsed;
      try { parsed = parseJsonResponse(j.result); } catch (e) {
        throw new ProviderError('Ответ Claude не JSON (возможно, обрезан): ' + e.message, { retryable: true, reduceBatch: texts.length > 1 });
      }
      return extractSentences(parsed, texts.length);
    },
    /** Короткая проверка входа: 1 предложение. */
    async ping({ signal } = {}) {
      return this.glossBatch(['Hello.'], { signal });
    },
  };
}

/** Короткий текстовый запрос (перевод выделения, если нет Ollama и встроенного переводчика браузера). */
export async function claudeText(prompt, { model = 'haiku', system = 'You are a precise English→Russian translator. Reply with the translation only.' } = {}) {
  const args = ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence', '--system-prompt', system,
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--effort', 'low'];
  const { out, err, code } = await runClaude(args, prompt);
  let j = null;
  try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || ''); } catch { /* не JSON */ }
  if (!j) throw classify(err || out || `claude завершился с кодом ${code}`);
  if (j.is_error) throw classify(j.result);
  return String(j.result || '').trim();
}
