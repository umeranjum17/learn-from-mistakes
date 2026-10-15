// The project config (.learn-from-mistakes.yaml) and the global one ($LFM_HOME/config.yaml), in no-mistakes' shape:
// the agent keys live in the global file and a project file may override some of them. Every key is checked here, and
// an unknown key is a usage error.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import * as doneDone from './sources/done-done.mjs';
import * as firstmate from './sources/firstmate.mjs';
import * as github from './sources/github.mjs';
import * as markdownLog from './sources/markdown-log.mjs';
import * as noMistakes from './sources/no-mistakes.mjs';
import * as sessions from './sources/sessions.mjs';

export const PROJECT_FILE = '.learn-from-mistakes.yaml';
// The source registry: one file per source type, each exporting validate (check and normalise its config entry)
// and read (its items). A source may also export metricNames, metricRows ('events' or 'records', the rows its metrics
// read), addsTo (another type's metric its records also feed) and metrics (its numbers from what it read; a type with no
// source in the config gives its metricNames as n/a),
// detect (the config entries init writes, by id) and doctor (a check line); init calls detect, doctor calls doctor.
// A source slice adds one line here.
export const SOURCES = { 'markdown-log': markdownLog, 'no-mistakes': noMistakes, sessions, github, 'done-done': doneDone, firstmate };
const METRICS = ['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped',
  'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'defects', 'gate_failures', 'decisions', 'blocks', 'steers', 'interventions_per_merge'];
// A metric name: one of METRICS, cause_count:<a configured cause>, or gate_failures:<a step no-mistakes read>. Targets and the ledger's --metric take these.
export const isMetric = (name, causes) => METRICS.includes(name)
  || (name.startsWith('cause_count:') && Object.hasOwn(causes, name.slice(12)))
  || (name.startsWith('gate_failures:') && name.length > 'gate_failures:'.length);
export const METRIC_RULE = `a metric (${METRICS.join(', ')}, or cause_count:<cause>, or gate_failures:<step>)`;
// A target or a tripwire: "<op> <number>", such as ">= 70".
export const RULE = /^(>=|<=|>|<|=) ?(\d+(?:\.\d+)?)$/;

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
// The model rule every path that sets a model obeys: a --model flag, the config file and the terminal pick.
export const MODEL_RULE = 'a model id (letters, digits and . _ / : @ + -, not starting with -), and <provider>/<model> for opencode';
export const modelOk = (agent, model) => /^[\w.@+][\w.\/:@+-]{0,199}$/.test(model) && (agent !== 'opencode' || model.includes('/'));
const posInt = (v, where) => check(Number.isInteger(v) && v >= 1, where, 'a positive integer');

// The agent keys, with no-mistakes' names and meanings. agent and judge_agent: one agent each, which the user sets: the
// tool never picks an agent (no auto, no detection) and never tries another when the one set is not ready.
export const AGENTS = ['claude', 'codex', 'opencode', 'pi', 'gemini']; // the native agent CLIs
export const AGENT_NAME = /^(claude|codex|opencode|pi|gemini|(acp|byokit):[a-z0-9][\w.-]*)$/;
const NAME = AGENT_NAME;
export const AGENT_RULE = 'claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>';
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_AGENTS = ['claude', 'codex', 'opencode', 'pi']; // the agents with an effort flag
// A project file may override these. The global-only keys pick the binary that runs and its flags, so a project file
// in a cloned repo cannot run a program of its choosing.
const AGENT_KEYS = ['agent', 'judge_agent', 'agent_config', 'agent_timeout', 'allow_premium'];
const GLOBAL_ONLY = ['auto_fix', 'state_root', 'agent_path_override', 'agent_args_override', 'acpx_path'];

// Applies the agent keys one file sets onto cfg, and records that file in cfg.from as the place to change each one.
function agentKeys(cfg, g, file) {
  for (const k of ['agent', 'judge_agent']) {
    if (g[k] === undefined) continue;
    if (Array.isArray(g[k])) throw new UsageError(`${file}: ${k} must be one agent, not a list`, `ask the user which one agent to use, then set ${k} in ${file} to it; the run never picks one`);
    check(NAME.test(g[k]), `${file}: ${k}`, AGENT_RULE);
    cfg[k] = g[k];
    cfg.from[k] = file;
  }
  for (const [a, c] of Object.entries(mapping(g.agent_config ?? {}, null, `${file}: agent_config`))) {
    const where = `${file}: agent_config.${a}`;
    check(NAME.test(a), `${file}: agent_config: ${a}`, 'an agent name: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>');
    mapping(c, ['model', 'effort'], where);
    check(c.model === undefined || (typeof c.model === 'string' && modelOk(a, c.model)), `${where}.model`, MODEL_RULE);
    if (c.effort !== undefined && !EFFORT_AGENTS.includes(a)) throw new UsageError(`${where}.effort: ${a} has no effort setting; remove it`);
    check(c.effort === undefined || EFFORTS.includes(c.effort), `${where}.effort`, EFFORTS.join(', '));
    cfg.agent_config[a] = { ...cfg.agent_config[a], ...c };
    cfg.from[`agent_config.${a}`] = file;
    if (c.model !== undefined) cfg.from[`agent_config.${a}.model`] = file;
  }
  if (g.agent_timeout !== undefined) {
    check(typeof g.agent_timeout === 'string' && /^[1-9]\d*[smh]$/.test(g.agent_timeout), `${file}: agent_timeout`, 'a duration such as 90s, 20m or 1h');
    cfg.agent_timeout = g.agent_timeout;
    cfg.from.agent_timeout = file;
  }
  if (g.allow_premium !== undefined) {
    check(typeof g.allow_premium === 'boolean', `${file}: allow_premium`, 'true or false');
    cfg.allow_premium = g.allow_premium;
    cfg.from.allow_premium = file;
  }
  return cfg;
}

const lfmHome = () => process.env.LFM_HOME || join(homedir(), '.learn-from-mistakes');
export const globalFile = () => join(lfmHome(), 'config.yaml');
// The global file with every default; cfg.from names, per agent key, the file that set it (here: the global file).
export function loadGlobal() {
  const home = lfmHome(), file = globalFile();
  const g = mapping(readYaml(file) ?? {}, [...AGENT_KEYS, ...GLOBAL_ONLY], file);
  const path = (v, where) => { check(typeof v === 'string' && v, where, 'a path to the binary'); return v.includes('/') ? expand(v, home) : v; }; // a bare name stays a PATH lookup
  const agent_path_override = mapping(g.agent_path_override ?? {}, AGENTS, `${file}: agent_path_override`);
  for (const [k, v] of Object.entries(agent_path_override)) agent_path_override[k] = path(v, `${file}: agent_path_override.${k}`);
  const agent_args_override = mapping(g.agent_args_override ?? {}, [...AGENTS, 'acp'], `${file}: agent_args_override`);
  for (const [k, v] of Object.entries(agent_args_override)) check(Array.isArray(v) && v.every((a) => typeof a === 'string'), `${file}: agent_args_override.${k}`, 'a list of strings');
  const cfg = { home, globalPath: file, state_root: g.state_root, agent_path_override, agent_args_override, acpx_path: g.acpx_path === undefined ? 'acpx' : path(g.acpx_path, `${file}: acpx_path`),
    agent: '', judge_agent: '', agent_config: {}, agent_timeout: '20m', allow_premium: false, auto_fix: 0, from: {} };
  if (g.auto_fix !== undefined) { check(Number.isInteger(g.auto_fix) && g.auto_fix >= 0, `${file}: auto_fix`, 'a whole number, 0 or more (0 = propose only)'); cfg.auto_fix = g.auto_fix; }
  return agentKeys(cfg, g, file);
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
  for (const k of GLOBAL_ONLY) if (Object.hasOwn(p, k)) throw new UsageError(`${file}: ${k} is global-only: set it in ${global.globalPath}`);
  mapping(p, ['name', 'window', 'sources', 'targets', 'causes', 'repeat', 'followup', 'excerpts', 'caps', 'signoff', ...AGENT_KEYS], file);
  const sources = mapping(p.sources ?? {}, null, `${file}: sources`);
  for (const [id, s] of Object.entries(sources)) {
    const where = `${file}: sources.${id}`;
    const type = mapping(s, null, where).type;
    if (typeof type !== 'string' || !Object.hasOwn(SOURCES, type)) throw new UsageError(`${where}.type must be one of ${Object.keys(SOURCES).join(', ')}`);
    const other = Object.keys(sources).find((k) => k !== id && sources[k]?.type === type);
    if (type === 'sessions' && other) throw new UsageError(`${where}: sources.${other} already reads sessions; keep one and list every agent in its agents`);
    if (type === 'github' && other) throw new UsageError(`${where}: sources.${other} already reads the PRs of origin's GitHub repo; keep one`);
    sources[id] = SOURCES[type].validate(s, where, dir);
  }
  const causes = mapping(p.causes ?? {}, null, `${file}: causes`);
  for (const [id, c] of Object.entries(causes)) {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) throw new UsageError(`${file}: causes.${id}: a cause key must be 1-64 of a-z, 0-9 and - (rename it, for example to ${id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 64)})`);
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
    check(isMetric(k, causes), `${file}: targets: ${k}`, METRIC_RULE);
    check(typeof v === 'string' && RULE.test(v), `${file}: targets.${k}`, 'a quoted "<op> <number>", such as ">= 70"');
  }
  // A firstmate home's targets file overrides targets:
  for (const s of Object.values(sources)) for (const k of Object.keys(s.targets ?? {})) check(isMetric(k, causes), `${s.targets_file}: ${k}`, METRIC_RULE);
  // the read range is this window and the last one; only the sessions source applies it so far
  if (p.window !== undefined) check(typeof p.window === 'string' && /^[1-9]\d{0,2}d$/.test(p.window), `${file}: window`, 'a number of days, such as 7d');
  const caps = block('caps', { invocations: 12, bundle_chars: 60000 });
  check(caps.bundle_chars >= 1000, `${file}: caps.bundle_chars`, 'at least 1000');
  if (p.signoff === 'auto') throw new UsageError(`${file}: signoff: auto is not a value; use on (the default) or off`);
  const cfg = {
    dir,
    name: p.name ?? basename(dir), sources, causes, repeat: block('repeat', { min_incidents: 3, min_days: 2 }),
    window: p.window ?? '7d',
    targets: { first_pass: '>= 70', p90_hours_to_merge: '<= 8', tool_error_rate: '<= 0.05', corrections_per_session: '<= 0.3', escaped: '<= 0', ...targets, ...Object.assign({}, ...Object.values(sources).map((s) => s.targets)) },
    followup: block('followup', { min_sessions: 3, min_days: 2 }), excerpts: one('excerpts', ['on', 'off']), caps,
    signoff: one('signoff', ['on', 'off']), ...agentKeys(global, p, file),
  };
  if (global.state_root) return { ...cfg, state: join(expand(String(global.state_root), global.home), cfg.name) };
  return { ...cfg, state: join(dir, '.lfm'), ignore: true };
}
