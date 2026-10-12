// The project config (.learn-from-mistakes.yaml) and the global one ($LFM_HOME/config.yaml). v1 configs load
// unchanged; the v2 keys get their defaults. Every key is checked here, and an unknown key is a usage error.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import * as markdownLog from './sources/markdown-log.mjs';
import * as noMistakes from './sources/no-mistakes.mjs';
import * as sessions from './sources/sessions.mjs';

export const PROJECT_FILE = '.learn-from-mistakes.yaml';
// The source registry: one file per source type, each exporting validate (check and normalise its config entry)
// and read (its items). A source may also export metricNames, metricRows ('events' or 'records', the rows its metrics
// read) and metrics (its numbers from what it read; a type with no source in the config gives its metricNames as n/a),
// detect (a config entry for init) and doctor (a check line); init calls detect, doctor calls doctor in a later slice.
// A source slice adds one line here.
export const SOURCES = { 'markdown-log': markdownLog, 'no-mistakes': noMistakes, sessions };
const RUNNERS = ['claude', 'codex', 'opencode', 'pi', 'gemini'];
const METRICS = ['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped',
  'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'defects', 'gate_failures', 'decisions', 'blocks', 'steers', 'interventions_per_merge'];

function readYaml(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw new UsageError(`${file}: ${e.message}`); }
  try { return parse(text) ?? {}; } catch (e) { throw new UsageError(`${file}: ${e.message.split('\n')[0]}`); }
}
export function mapping(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${where} must be a mapping`);
  for (const k of Object.keys(value)) if (keys && !keys.includes(k)) throw new UsageError(`${where}: unknown key ${k}`);
  return value;
}
export const expand = (p, dir) => resolve(dir, p.replace(/^~(?=\/|$)/, homedir()));
// The config entry of a source read from one file: { type, path }, the path resolved against the project dir.
export function pathSource(s, where, dir) {
  mapping(s, ['type', 'path'], where);
  if (typeof s.path !== 'string') throw new UsageError(`${where}.path must be a string`);
  return { ...s, path: expand(s.path, dir) };
}
const check = (ok, where, rule) => { if (!ok) throw new UsageError(`${where} must be ${rule}`); };
const posInt = (v, where) => check(Number.isInteger(v) && v >= 1, where, 'a positive integer');

// worker and judge: which agent CLI runs the tool's agent steps, and with which model ("" = the runner's default).
function role(value, where) {
  const r = { runner: 'auto', model: '', ...mapping(value ?? {}, ['runner', 'model'], where) };
  check(r.runner === 'auto' || RUNNERS.includes(r.runner) || /^(acp|byokit):\S+$/.test(r.runner), `${where}.runner`, `auto, ${RUNNERS.join(', ')}, acp:<target> or byokit:<route>`);
  check(typeof r.model === 'string', `${where}.model`, 'a string');
  return r;
}

export function loadGlobal() {
  const LFM_HOME = process.env.LFM_HOME || join(homedir(), '.learn-from-mistakes');
  const file = join(LFM_HOME, 'config.yaml');
  const g = mapping(readYaml(file) ?? {}, ['state_root', 'runner_path', 'runner_args'], file);
  const runner_path = mapping(g.runner_path ?? {}, [...RUNNERS, 'acp'], `${file}: runner_path`);
  for (const [k, v] of Object.entries(runner_path)) {
    check(typeof v === 'string' && v, `${file}: runner_path.${k}`, 'a path to the agent binary');
    if (v.includes('/')) runner_path[k] = expand(v, LFM_HOME); // a bare name stays a PATH lookup
  }
  const runner_args = mapping(g.runner_args ?? {}, [...RUNNERS, 'acp'], `${file}: runner_args`);
  for (const [k, v] of Object.entries(runner_args)) check(Array.isArray(v) && v.every((a) => typeof a === 'string'), `${file}: runner_args.${k}`, 'a list of strings');
  return { home: LFM_HOME, state_root: g.state_root, runner_path, runner_args };
}

export function loadConfig(dir) {
  const global = loadGlobal();
  const file = join(dir, PROJECT_FILE);
  const p = readYaml(file);
  if (p === undefined) throw new UsageError(`no ${PROJECT_FILE} in ${dir} (or pass --dir <project>); a minimal one:
name: my-project
sources:
  log: { type: markdown-log, path: defects.md }   # each "- " bullet is one record`, 'learn-from-mistakes-axi guide   # the full config, then ingest, label and report');
  if (p.name !== undefined) check(typeof p.name === 'string', `${file}: name`, 'a string');
  mapping(p, ['name', 'worker', 'judge', 'window', 'sources', 'targets', 'causes', 'repeat', 'followup', 'excerpts', 'caps', 'signoff', 'allow_premium'], file);
  const sources = mapping(p.sources ?? {}, null, `${file}: sources`);
  for (const [id, s] of Object.entries(sources)) {
    const where = `${file}: sources.${id}`;
    const type = mapping(s, null, where).type;
    if (typeof type !== 'string' || !Object.hasOwn(SOURCES, type)) throw new UsageError(`${where}.type must be one of ${Object.keys(SOURCES).join(', ')}`);
    const other = Object.keys(sources).find((k) => k !== id && sources[k]?.type === 'sessions');
    if (type === 'sessions' && other) throw new UsageError(`${where}: sources.${other} already reads every agent's sessions; keep one and narrow it with agents`);
    sources[id] = SOURCES[type].validate(s, where, dir);
  }
  const causes = mapping(p.causes ?? {}, null, `${file}: causes`);
  for (const [id, c] of Object.entries(causes)) {
    mapping(c, ['description', 'match'], `${file}: causes.${id}`);
    if (typeof c.description !== 'string') throw new UsageError(`${file}: causes.${id}.description must be a string`);
    if (c.match === undefined) continue;
    // The rule tags the items of one source: gate rows by error text; session events by signal, tool and text.
    const where = `${file}: causes.${id}.match`, type = sources[mapping(c.match, null, where).source]?.type;
    const text = (k) => check(c.match[k] === undefined || (typeof c.match[k] === 'string' && c.match[k]), `${where}.${k}`, 'a non-empty string');
    if (type === 'no-mistakes') {
      mapping(c.match, ['source', 'error_contains'], where);
      check(c.match.error_contains !== undefined, `${where}.error_contains`, 'a non-empty string');
      text('error_contains');
    } else if (type === 'sessions') {
      mapping(c.match, ['source', 'signal', 'tool', 'text_contains'], where);
      if (!['signal', 'tool', 'text_contains'].some((k) => c.match[k] !== undefined)) throw new UsageError(`${where} needs a signal, tool or text_contains`);
      check(c.match.signal === undefined || sessions.SIGNALS.includes(c.match.signal), `${where}.signal`, `one of ${sessions.SIGNALS.join(', ')}`);
      text('tool');
      text('text_contains');
    } else throw new UsageError(`${where}.source must name a no-mistakes or sessions source`);
  }
  const block = (key, defaults) => {
    const v = { ...defaults, ...mapping(p[key] ?? {}, Object.keys(defaults), `${file}: ${key}`) };
    for (const [k, n] of Object.entries(v)) if (typeof defaults[k] === 'number') posInt(n, `${file}: ${key}.${k}`);
    return v;
  };
  const one = (key, allowed) => {
    if (p[key] !== undefined) check(allowed.includes(p[key]), `${file}: ${key}`, allowed.join(' or '));
    return p[key] ?? allowed[0];
  };
  const targets = mapping(p.targets ?? {}, null, `${file}: targets`);
  for (const [k, v] of Object.entries(targets)) {
    check(METRICS.includes(k) || (k.startsWith('cause_count:') && Object.hasOwn(causes, k.slice(12))), `${file}: targets: ${k}`,
      `a metric (${METRICS.join(', ')}, or cause_count:<cause>)`);
    check(typeof v === 'string' && /^(>=|<=|>|<|=) ?\d+(\.\d+)?$/.test(v), `${file}: targets.${k}`, 'a quoted "<op> <number>", such as ">= 70"');
  }
  // the read range is this window and the last one; only the sessions source applies it so far
  if (p.window !== undefined) check(typeof p.window === 'string' && /^[1-9]\d{0,2}d$/.test(p.window), `${file}: window`, 'a number of days, such as 7d');
  const caps = block('caps', { invocations: 12, bundle_chars: 60000, timeout: '20m' });
  check(caps.bundle_chars >= 1000, `${file}: caps.bundle_chars`, 'at least 1000');
  check(typeof caps.timeout === 'string' && /^[1-9]\d*[smh]$/.test(caps.timeout), `${file}: caps.timeout`, 'a duration such as 90s, 20m or 1h');
  const cfg = {
    dir,
    name: p.name ?? basename(dir), sources, causes, repeat: block('repeat', { min_incidents: 3, min_days: 2 }),
    worker: role(p.worker, `${file}: worker`), judge: role(p.judge, `${file}: judge`), window: p.window ?? '7d',
    targets: { first_pass: '>= 70', p90_hours_to_merge: '<= 8', tool_error_rate: '<= 0.05', corrections_per_session: '<= 0.3', escaped: '<= 0', ...targets },
    followup: block('followup', { min_sessions: 3, min_days: 2 }), excerpts: one('excerpts', ['on', 'off']), caps,
    signoff: one('signoff', ['auto', 'off']), allow_premium: one('allow_premium', [false, true]),
    runner_path: global.runner_path, runner_args: global.runner_args,
  };
  if (global.state_root) return { ...cfg, state: join(expand(String(global.state_root), global.home), cfg.name) };
  return { ...cfg, state: join(dir, '.lfm'), ignore: true };
}
