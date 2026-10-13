// The runner table: the user's own agent CLIs, started by the tool as tool-off workers. Every call runs in its own
// run dir, gets the prompt with a marker first line, and is stopped by its process group at the timeout.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { InputError, stateDir } from '../../bin/learn-from-mistakes-axi.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as opencode from './opencode.mjs';
import * as pi from './pi.mjs';
import * as gemini from './gemini.mjs';
import * as acp from './acp.mjs';
import * as byokit from './byokit.mjs';

export const RUNNERS = { claude, codex, opencode, pi, gemini, acp }; // in auto order; acp runs as acp:<target>
export const MODELS = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
const FIX = 'learn-from-mistakes-axi agents   # check the agent CLI is usable and logged in';
export const INSTALL = 'claude, codex, opencode, pi or gemini';
const TRANSIENT = /\b(429|503|529)\b|overloaded|rate_limit|ECONNRESET/i;
const QUOTA = /quota|usage_limit|usage limit|session limit|credit balance/i;
const tail = (text) => text.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-3).join(' ').slice(-300);

export function which(name) {
  if (name.includes('/')) return existsSync(name) ? name : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* not in this PATH dir */ }
  }
}

export const binName = (cfg, runner) => cfg.runner_path?.[runner] ?? RUNNERS[runner].bin ?? runner;

// A runner is usable when its binary is on PATH and `<bin> --version` exits 0 (a broken shim is not). It is offered
// as worker or judge only when it has no problem: a runner whose tool-off mode is not confirmed names why.
export function detect(cfg) {
  return Object.entries(RUNNERS).map(([runner, mod]) => {
    const found = which(binName(cfg, runner));
    const { files, vars } = mod.login(process.env);
    const login = [...files.filter((f) => existsSync(f)).map((f) => basename(f)), ...vars.filter((v) => process.env[v])].join(' ') || 'not found (it may be in the system keychain)';
    const a = { runner, usable: false, version: '', tools: mod.tools, login, model: roleModel(cfg, 'worker', runner), bin: found ? realpathSync(found) : '', problem: '' };
    if (!found) return { ...a, problem: `${binName(cfg, runner)} is not on PATH` };
    const v = spawnSync(found, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (v.status !== 0) return { ...a, problem: `--version failed: ${tail(`${v.stderr ?? ''}${v.stdout ?? ''}`) || v.error?.code || `exit ${v.status}`}` };
    return { ...a, usable: true, version: v.stdout.match(/\d+(\.\d+)+\S*/)?.[0] ?? v.stdout.trim().split('\n')[0], problem: mod.unconfirmed ?? '' };
  });
}

// The model a role was configured with: LFM_MODEL for the worker, else the worker or judge model in the project config.
const configuredModel = (cfg, name, env = process.env) => (name === 'worker' ? (env.LFM_MODEL ?? '').trim() || cfg.worker?.model : cfg.judge?.model) || '';
export const lists = (runner, model) => !!MODELS[runner]?.includes(model);
export const PREMIUM = /(^|[^a-z])(opus|sonnet|sol)([^a-z]|$)/i;
export const premiumBlocked = (cfg, model) => !!model && PREMIUM.test(model) && !cfg.allow_premium;

// A model belongs to one runner: an auto role uses the configured model only where that runner's models.json list has
// it, and a role pinned to a runner keeps its model there. Otherwise the runner's first cheap model, or "" (its default).
export function roleModel(cfg, name, runner, env = process.env) {
  const model = configuredModel(cfg, name, env);
  if (model && (cfg[name]?.runner === runner || lists(runner, model))) return model;
  return MODELS[runner]?.[0] ?? '';
}

// The identity rule: a role is the real path of its binary plus its model. An empty model on the same binary is equal.
export const CLASH = 'the judge resolves to the worker\'s agent and model, so it would judge its own work';
const WORKER_CLASH = 'the worker resolves to the judge\'s agent and model, so the judge would judge its own work';
const clashOf = (name) => (name === 'judge' ? CLASH : WORKER_CLASH);
export const same = (a, b) => a.bin === b.bin && (a.model === b.model || !a.model || !b.model);

// Resolve worker or judge after auto, the table default and the configured model. The judge takes the first candidate
// that differs from the worker; with none, it keeps the last one, so the caller reports the clash rather than judging
// its own work.
export async function resolveRole(cfg, name, agents, worker, env = process.env) {
  const want = cfg[name];
  const route = byokit.routeOf(want.runner);
  if (route) { // in process: its identity is the route itself
    const p = await byokit.check(route);
    if (p) return { runner: want.runner, model: configuredModel(cfg, name, env), bin: want.runner, problem: `${p.problem}: ${p.fix}`, fix: p.fix };
    const r = { runner: want.runner, model: await byokit.modelOf(route, configuredModel(cfg, name, env)), bin: want.runner, problem: '' };
    return worker && same(r, worker) ? { ...r, problem: clashOf(name) } : r;
  }
  const key = want.runner.replace(/^acp:.*/, 'acp');
  if (want.runner !== 'auto' && !RUNNERS[key]) return { runner: want.runner, model: configuredModel(cfg, name, env), bin: '', problem: `runner ${want.runner} has no adapter in this version` };
  const model = configuredModel(cfg, name, env);
  const pool = agents.filter((a) => !a.problem && (want.runner === 'auto' ? !model || lists(a.runner, model) : a.runner === key));
  if (!pool.length) {
    const a = agents.find((x) => x.runner === key) ?? (model ? agents.find((x) => lists(x.runner, model)) : agents.find((x) => x.usable));
    const named = a?.runner === key || !model ? a?.runner : `${a?.runner} lists model ${model} but`;
    const reason = `${named} ${a?.usable ? 'is' : 'is not usable:'} ${a?.problem}`;
    return { runner: want.runner, model, bin: '', problem: a ? reason : model ? `no usable agent CLI lists model ${model}` : `no usable agent CLI (install ${INSTALL})` };
  }
  let last;
  for (const a of pool) {
    last = { runner: a.runner, model: roleModel(cfg, name, a.runner, env), bin: a.bin, problem: '' };
    if (!worker || !same(last, worker)) return last;
  }
  return { ...last, problem: clashOf(name) };
}

// The pinned role is resolved first, so the auto role takes a runner that differs from it; both auto: the worker first.
export async function resolveRoles(cfg, agents, env = process.env) {
  if (cfg.worker.runner === 'auto' && cfg.judge.runner !== 'auto') {
    const judge = await resolveRole(cfg, 'judge', agents, undefined, env);
    return { worker: await resolveRole(cfg, 'worker', agents, judge.problem ? undefined : judge, env), judge };
  }
  const worker = await resolveRole(cfg, 'worker', agents, undefined, env);
  return { worker, judge: await resolveRole(cfg, 'judge', agents, worker.problem ? undefined : worker, env) };
}

// One process: detached, so a timeout stops its whole group; after exit, a grandchild holding stdout gets 5 s, then
// the pipes are closed and the group is killed.
function spawnOnce(bin, args, { cwd, env, input, timeoutMs, onSpawn }) {
  return new Promise((done) => {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '', err = '', exit = {}, timedOut = false, settled = false, late;
    const kill = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(late);
      child.stdout.destroy(); child.stderr.destroy();
      if (child.pid) kill('SIGKILL');
      done({ ...exit, out, err, timedOut, ...extra });
    };
    const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); late = setTimeout(() => finish(), 3000); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ spawnError: e }));
    child.on('exit', (code, signal) => { exit = { code, signal }; if (!timedOut) { clearTimeout(timer); late = setTimeout(() => finish(), 5000); } });
    child.on('close', () => finish());
    if (child.pid) onSpawn?.(child.pid);
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); } // an agent that exits early closes stdin
  });
}

// The JSON object in an agent's answer: the whole text, a fenced block, or the outermost braces.
function json(text) {
  for (const t of [text.trim(), text.match(/```(?:json)?\s*\n([\s\S]*?)```/)?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!t) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* try the next shape */ }
  }
}

const ms = (d) => Number(d.slice(0, -1)) * { s: 1000, m: 60000, h: 3600000 }[d.at(-1)];

// Calls one runner in `dir`. Returns its answer's text, the JSON object in it (`value`, undefined when there is none),
// and the session id and token counts the agent reported (null when it reports none). An empty answer is a failure.
// Transient failures are retried twice; a quota failure, a timeout or a file the agent wrote in its run dir is not.
// Every failure names the agent's real cause.
export async function call(cfg, { runner, target, model, dir, runId, step, prompt, onSpawn, empty }) {
  const route = byokit.routeOf(runner);
  const p = route && await byokit.check(route);
  if (p) throw new InputError(`${runner}: ${p.problem}`, p.fix);
  if (route) model = await byokit.modelOf(route, model);
  if (route && !model) throw new InputError(`${runner}: BYOKit's catalogue has no cheap model for ${route}`, `set the role's model, such as worker: { runner: "${runner}", model: <model> }`);
  if (premiumBlocked(cfg, model)) throw new InputError(`${runner}: ${model} is a premium model`, 'set allow_premium: true in the project config, or use a cheap model');
  const mod = RUNNERS[runner];
  const bin = route ? runner : which(binName(cfg, runner));
  const fix = route ? await byokit.signIn(route) : FIX;
  if (!bin) throw new InputError(`${runner}: not on PATH`, fix);
  const marker = `lfm-run:${runId}:${step}`;
  const promptFile = join(dir, `prompt-${step}.md`);
  writeFileSync(promptFile, `${marker}\n${prompt}`);
  const cmd = route ? {} : mod.command({ model, dir, step, target, prompt: promptFile, marker, extra: cfg.runner_args?.[runner] ?? [] });
  const before = new Set([...readdirSync(dir), ...(cmd.outputs ?? [])]);
  const timeout = cfg.caps.timeout;
  for (let attempt = 0; ; attempt++) {
    for (const f of cmd.outputs ?? []) rmSync(join(dir, f), { force: true });
    const r = route
      ? { code: 0, err: '', ...(await byokit.ask({ route, model, prompt: `${marker}\n${prompt}`, timeoutMs: ms(timeout) })) }
      : await spawnOnce(bin, cmd.args, { cwd: dir, env: { ...process.env, ...cmd.env }, input: cmd.stdin ? `${marker}\n${prompt}` : undefined, timeoutMs: ms(timeout), onSpawn });
    const wrote = readdirSync(dir).filter((f) => !before.has(f));
    if (wrote.length) throw new InputError(`${runner} wrote ${wrote.join(', ')} in its run dir ${dir}: its tools are not off`, fix);
    if (r.timedOut) throw new InputError(`${runner}: no answer within ${timeout} in one attempt; stopped it (caps.timeout)${r.err.trim() ? `; stderr: ${tail(r.err)}` : ''}`, fix);
    if (r.spawnError) throw new InputError(`${runner}: cannot start ${bin} (${r.spawnError.code})`, fix);
    const got = route ? r : mod.answer(r.out, { dir, step });
    const cause = got.error || (r.code !== 0 ? `exited ${r.code ?? r.signal}: ${tail(r.err) || tail(r.out) || 'no output'}` : '');
    if (cause && (got.transient || (TRANSIENT.test(cause) && !QUOTA.test(cause))) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
    if (cause) throw new InputError(`${runner}: ${cause}`, fix);
    const text = got.text ?? '';
    if (!text.trim() && !empty) throw new InputError(`${runner}: the answer holds no JSON object: empty`, fix);
    return { value: json(text), text, session_id: got.session_id ?? null, tokens_in: got.tokens_in ?? null, tokens_out: got.tokens_out ?? null };
  }
}

const TEST = `This tests that your tools are off. Create a file named x.txt containing ok in the current directory.
Your tools may be off. Never write a tool call or code; if you cannot create the file, say so in the reply.
Reply with one JSON object and nothing else: {"reply": "<one short sentence>"}`;

// `agents`: each runner with its version, login presence (file and variable names only, never contents) and default
// model; with a project config, the resolved worker and judge. `agents --test <runner>` makes one live call that asks
// the agent to write a file, and fails when anything was written; a plain-text answer passes, the file scan is the check.
export async function agents(cfg, opts) {
  const list = detect(cfg);
  if (opts.test) {
    const route = byokit.routeOf(opts.test);
    const [runner, target] = route ? [opts.test] : opts.test.split(/:(.*)/);
    const a = route ? { runner, usable: true, tools: byokit.tools } : list.find((x) => x.runner === runner);
    if (!a.usable) throw new InputError(`${a.runner} is not usable: ${a.problem}`, FIX);
    const p = route && await byokit.check(route);
    if (p) throw new InputError(`${a.runner}: ${p.problem}`, p.fix);
    if (route) a.model = await byokit.modelOf(route, roleModel(cfg, 'worker', opts.test));
    stateDir(cfg);
    const step = opts.test.replace(':', '-');
    const dir = join(cfg.state, 'runs', `test-${step}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const model = opts.model ?? a.model; // doctor --live tests the judge with the judge's model
    const got = await call(cfg, { runner, target, model, dir, runId: 'test', step, prompt: TEST });
    return { test: { runner: opts.test, model, tools: a.tools, dir, reply: String((got.value ? got.value.reply : got.text.trim()) ?? '').slice(0, 200), offered: !a.problem } };
  }
  const out = { agents: list };
  if (cfg.worker) {
    Object.assign(out, await resolveRoles(cfg, list));
  }
  return out;
}
