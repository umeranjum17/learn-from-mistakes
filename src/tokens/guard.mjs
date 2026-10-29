// The poll guard's install and status. The hook itself is poll.mjs, which the settings entry runs directly.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import * as claude from '../sessions/claude.mjs';
import { guardDir as dir, MATCHER } from './poll.mjs';

const HOOK = realpathSync(fileURLToPath(new URL('poll.mjs', import.meta.url)));

// The settings file the hook entries go in: the user's Claude Code settings, or the project's with --project-hook.
const settingsFile = (opts) => (opts['project-hook'] ? join(opts.dir, '.claude', 'settings.json') : join(dirname(claude.root()), 'settings.json'));
const command = () => `${shq(process.execPath)} ${shq(HOOK)}`;
const ours = (entry) => (entry?.hooks ?? []).some((h) => typeof h?.command === 'string' && /src[\\/]tokens[\\/]poll\.mjs'?$/.test(h.command)); // this tool's, from any install path

function readSettings(file) {
  if (!existsSync(file)) return {};
  let s;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new UsageError(`${file}: not JSON the guard can add to (${e.code ?? e.message.split('\n')[0]}); it was left as it is`, `edit ${shq(file)}   # make it valid JSON, then run the install again`);
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new UsageError(`${file}: not a JSON object; it was left as it is`, `edit ${shq(file)}   # make it a JSON object, then run the install again`);
  return s;
}

// `tokens guard install`: writes the PreToolUse entry and the SessionStart (compact) entry that resets the count, and
// replaces an earlier entry of its own, so a second install changes nothing. Every other key and hook stays.
export function install(opts) {
  const file = settingsFile(opts), s = readSettings(file), before = JSON.stringify(s);
  const entry = (matcher) => ({ matcher, hooks: [{ type: 'command', command: command(), timeout: 5 }] });
  if (s.hooks !== undefined && (typeof s.hooks !== 'object' || Array.isArray(s.hooks))) throw new UsageError(`${file}: hooks is not an object; it was left as it is`, `edit ${shq(file)}   # make hooks an object, then run the install again`);
  s.hooks ??= {};
  for (const [event, matcher] of [['PreToolUse', MATCHER], ['SessionStart', 'compact']]) {
    if (s.hooks[event] !== undefined && !Array.isArray(s.hooks[event])) throw new UsageError(`${file}: hooks.${event} is not a list; it was left as it is`, `edit ${shq(file)}   # make hooks.${event} a list, then run the install again`);
    s.hooks[event] = [...(s.hooks[event] ?? []).filter((e) => !ours(e)), entry(matcher)];
  }
  const changed = JSON.stringify(s) !== before;
  if (changed) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`); }
  // An npx copy can be cleaned away, and the hook would then fail (open) on every call.
  const note = HOOK.split(sep).includes('_npx') ? `the hook runs from an npx cache that can be cleaned away; npm i -g learn-from-mistakes-axi and run the install again` : null;
  return { settings: file, status: changed ? 'installed' : 'unchanged', command: command(), events: `PreToolUse ${MATCHER}, SessionStart compact`, note };
}

// `tokens guard status`: where the hook is installed, and what it blocked: today, in total, and the last few.
export function status(opts) {
  const where = [['user', settingsFile({})], ['project', settingsFile({ ...opts, 'project-hook': true })]]
    .filter(([, f]) => { try { return Object.values(readSettings(f).hooks ?? {}).some((l) => Array.isArray(l) && l.some(ours)); } catch { return false; } });
  let fired = [];
  try { fired = readFileSync(join(dir(), 'fired.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) {
    if (e.code !== 'ENOENT') throw new UsageError(`${join(dir(), 'fired.jsonl')}: cannot read (${e.code ?? e.message})`, `mv ${shq(join(dir(), 'fired.jsonl'))} <elsewhere>   # the guard starts a new log`);
  }
  const today = new Date().toISOString().slice(0, 10);
  const line = `poll guard: ${where.length ? `installed (${where.map(([w, f]) => `${w} ${f}`).join(', ')})` : 'not installed'} · blocked ${fired.filter((f) => f.at?.startsWith(today)).length} today, ${fired.length} in total in ${new Set(fired.map((f) => f.session)).size} sessions${fired.length ? ` · last ${fired.at(-1).at}` : ''}`;
  return { line, installed: where.map(([scope, settings]) => ({ scope, settings })), today: fired.filter((f) => f.at?.startsWith(today)).length, total: fired.length, recent: fired.slice(-5).reverse() };
}
