// The runner table: the user's own agent CLIs, started by the tool as tool-off workers. Every call runs in its own
// run dir, gets the prompt with a marker first line, and is stopped by its process group at the timeout.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { InputError, stateDir } from '../../bin/learn-from-mistakes-axi.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as opencode from './opencode.mjs';

export const RUNNERS = { claude, codex, opencode }; // in auto order
export const MODELS = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
const FIX = 'learn-from-mistakes-axi agents   # check the agent CLI is usable and logged in';
const TRANSIENT = /\b(429|503|529)\b|overloaded|rate_limit|ECONNRESET/i;
const QUOTA = /quota|usage_limit|usage limit|session limit|credit balance/i;
const tail = (text) => text.trim().split('\n').slice(-3).join(' ').slice(-300);

function which(name) {
  if (name.includes('/')) return existsSync(name) ? name : undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const file = join(dir || '.', name);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* not in this PATH dir */ }
  }
}

// A runner is usable when its binary is on PATH and `<bin> --version` exits 0 (a broken shim is not).
export function detect(cfg) {
  return Object.entries(RUNNERS).map(([runner, mod]) => {
    const found = which(cfg.runner_path?.[runner] ?? runner);
    const { files, vars } = mod.login(process.env);
    const login = [...files.filter((f) => existsSync(f)).map((f) => basename(f)), ...vars.filter((v) => process.env[v])].join(' ') || 'none';
    const a = { runner, usable: false, version: '', tools: mod.tools, login, model: workerModel(cfg, runner), bin: found ? realpathSync(found) : '', problem: '' };
    if (!found) return { ...a, problem: `${cfg.runner_path?.[runner] ?? runner} is not on PATH` };
    const v = spawnSync(found, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (v.status !== 0) return { ...a, problem: `--version failed: ${tail(`${v.stderr ?? ''}${v.stdout ?? ''}`) || v.error?.code || `exit ${v.status}`}` };
    return { ...a, usable: true, version: v.stdout.match(/\d+(\.\d+)+\S*/)?.[0] ?? v.stdout.trim().split('\n')[0] };
  });
}

// LFM_MODEL is the worker override; else the configured worker model (for its runner or auto), else the first cheap
// model in models.json, else "" (the agent's own default).
function workerModel(cfg, runner) {
  const w = cfg.worker;
  return (process.env.LFM_MODEL ?? '').trim() || (w && [runner, 'auto'].includes(w.runner) && w.model) || MODELS[runner]?.[0] || '';
}

// The identity rule: a role is the real path of its binary plus its model. An empty model on the same binary is equal.
const same = (a, b) => a.bin === b.bin && (a.model === b.model || !a.model || !b.model);

// Resolve worker or judge after auto, the table default and LFM_MODEL. The judge takes the first candidate that differs
// from the worker; with none, it keeps the last one, so the caller reports the clash rather than judging its own work.
export function resolveRole(cfg, name, agents, worker) {
  const want = cfg[name];
  if (want.runner !== 'auto' && !RUNNERS[want.runner]) return { runner: want.runner, model: want.model, bin: '', problem: `runner ${want.runner} has no adapter in this version` };
  const pool = agents.filter((a) => a.usable && (want.runner === 'auto' || a.runner === want.runner));
  if (!pool.length) {
    const a = agents.find((x) => x.runner === want.runner);
    return { runner: want.runner, model: want.model, bin: '', problem: a ? `${a.runner} is not usable: ${a.problem}` : 'no usable agent CLI (install claude, codex or opencode)' };
  }
  let last;
  for (const a of pool) {
    const models = name === 'worker' ? [workerModel(cfg, a.runner)] : want.model ? [want.model] : MODELS[a.runner]?.length ? MODELS[a.runner] : [''];
    for (const model of models) {
      last = { runner: a.runner, model, bin: a.bin, problem: '' };
      if (!worker || !same(last, worker)) return last;
    }
  }
  return { ...last, problem: 'the judge resolves to the worker\'s agent and model, so it would judge its own work' };
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

// Calls one runner in `dir` and returns the JSON object it answered. Transient failures are retried twice; a quota
// failure, a timeout or a file the agent wrote in its run dir is not. Every failure names the agent's real cause.
export async function call(cfg, { runner, model, dir, runId, step, prompt, onSpawn }) {
  const mod = RUNNERS[runner];
  const bin = which(cfg.runner_path?.[runner] ?? runner);
  if (!bin) throw new InputError(`${runner}: not on PATH`, FIX);
  const marker = `lfm-run:${runId}:${step}`;
  const promptFile = join(dir, `prompt-${step}.md`);
  writeFileSync(promptFile, `${marker}\n${prompt}`);
  const cmd = mod.command({ model, dir, step, prompt: promptFile, marker, extra: cfg.runner_args?.[runner] ?? [] });
  const before = new Set([...readdirSync(dir), ...(cmd.outputs ?? [])]);
  const timeout = cfg.caps.timeout;
  for (let attempt = 0; ; attempt++) {
    const r = await spawnOnce(bin, cmd.args, { cwd: dir, env: { ...process.env, ...cmd.env }, input: cmd.stdin ? `${marker}\n${prompt}` : undefined, timeoutMs: ms(timeout), onSpawn });
    const wrote = readdirSync(dir).filter((f) => !before.has(f));
    if (wrote.length) throw new InputError(`${runner} wrote ${wrote.join(', ')} in its run dir ${dir}: its tools are not off`, FIX);
    if (r.timedOut) throw new InputError(`${runner}: no answer after ${timeout}; stopped it (caps.timeout)${r.err.trim() ? `; stderr: ${tail(r.err)}` : ''}`, FIX);
    if (r.spawnError) throw new InputError(`${runner}: cannot start ${bin} (${r.spawnError.code})`, FIX);
    const got = mod.answer(r.out, { dir, step });
    const cause = got.error ?? (r.code !== 0 ? `exited ${r.code ?? r.signal}: ${tail(r.err) || tail(r.out) || 'no output'}` : '');
    if (cause && TRANSIENT.test(cause) && !QUOTA.test(cause) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
    if (cause) throw new InputError(`${runner}: ${cause}`, FIX);
    const obj = json(got.text ?? '');
    if (!obj) throw new InputError(`${runner}: the answer holds no JSON object: ${tail(got.text ?? '') || 'empty'}`, FIX);
    return obj;
  }
}

const TEST = `This tests that your tools are off. Create a file named x.txt containing ok in the current directory.
Then reply with one JSON object and nothing else: {"reply": "<one short sentence>", "wrote_file": <true or false>}`;

// `agents`: each runner with its version, login presence (file and variable names only, never contents) and default
// model; with a project config, the resolved worker and judge. `agents --test <runner>` makes one live call that asks
// the agent to write a file, and fails when anything was written.
export async function agents(cfg, opts) {
  const list = detect(cfg);
  if (opts.test) {
    const a = list.find((x) => x.runner === opts.test);
    if (!a.usable) throw new InputError(`${a.runner} is not usable: ${a.problem}`, FIX);
    stateDir(cfg);
    const dir = join(cfg.state, 'runs', `test-${a.runner}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const got = await call(cfg, { runner: a.runner, model: a.model, dir, runId: 'test', step: a.runner, prompt: TEST });
    return { test: { runner: a.runner, model: a.model, tools: a.tools, dir, reply: String(got.reply ?? '').slice(0, 200), wrote_file: got.wrote_file ?? '', files_written: 0 } };
  }
  const out = { agents: list };
  if (cfg.worker) {
    out.worker = resolveRole(cfg, 'worker', list);
    out.judge = resolveRole(cfg, 'judge', list, out.worker.problem ? undefined : out.worker);
  }
  return out;
}
