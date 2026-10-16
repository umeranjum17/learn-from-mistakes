// The runner table: the user's own agent CLIs, started by the tool as tool-off workers. Every call runs in its own
// run dir, gets the prompt with a marker first line, and is stopped by its process group at the timeout.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { InputError, shq, stateDir } from '../../bin/learn-from-mistakes-axi.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as opencode from './opencode.mjs';
import * as pi from './pi.mjs';
import * as gemini from './gemini.mjs';
import * as acp from './acp.mjs';
import * as byokit from './byokit.mjs';
import { PROJECT_FILE } from '../config.mjs';

export const RUNNERS = { claude, codex, opencode, pi, gemini, acp }; // acp runs as acp:<target>
const FIX = 'learn-from-mistakes-axi agents   # check the agent CLI is usable and logged in';
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

export const binName = (cfg, runner) => (runner === 'acp' ? cfg.acpx_path : cfg.agent_path_override?.[runner]) ?? RUNNERS[runner].bin ?? runner;
// The model agent_config gives an agent (claude, acp:<target>, byokit:<route>), or "": none set, and no call is made.
export const agentModel = (cfg, agent) => cfg.agent_config?.[agent]?.model ?? '';
// The file to change a key in: the file that set it; a key no file sets goes to the project file, else the global file.
export const fileOf = (cfg, key) => shq(cfg.from?.[key] ?? (cfg.dir ? join(cfg.dir, PROJECT_FILE) : cfg.globalPath));
// The fix for an agent or its model the user has not set, or that is not ready: the user chooses, and the file and key are named.
export const chooseFix = (cfg, key, agent) => {
  const file = fileOf(cfg, key), modelFile = agent && fileOf(cfg, `agent_config.${agent}.model`);
  const where = !agent || modelFile === file ? `set ${key} and its agent_config model in ${file}` : `set ${key} in ${file} and its agent_config model in ${modelFile}`;
  return `ask the user which agent and model to use, then ${where}; the run never picks one`;
};

// The RUNNERS key of a configured agent name (`acp:<target>` names the acp runner; a byokit: route is not a runner).
export const runnerKey = (name) => name?.replace(/^acp:.*/, 'acp');
// The runners the configured roles need: the worker's and the judge's, deduped, less any that is not a RUNNERS key.
export const configuredRunners = (cfg) => [...new Set([runnerKey(cfg.agent), runnerKey(cfg.judge_agent)].filter((k) => k && k in RUNNERS))];

// A runner is usable when its binary is on PATH and `<bin> --version` exits 0 (a broken shim is not). It is offered
// as worker or judge only when it has no problem: a runner whose tool-off mode is not confirmed names why.
// Only `only` is probed, so no command runs --version or reads the login store of an agent the user did not pick; a
// caller that needs another runner (an explicit `agents --test`, init's chosen roles) names it. Default: the roles set.
export function detect(cfg, only = configuredRunners(cfg)) {
  const names = new Set(only);
  return Object.entries(RUNNERS).filter(([runner]) => names.has(runner)).map(([runner, mod]) => {
    const found = which(binName(cfg, runner));
    const { files, vars } = mod.login(process.env);
    const login = [...files.filter((f) => existsSync(f)).map((f) => basename(f)), ...vars.filter((v) => process.env[v])].join(' ') || 'not found (it may be in the system keychain)';
    const a = { runner, usable: false, version: '', tools: mod.tools, login, model: agentModel(cfg, runner), bin: found ? realpathSync(found) : '', problem: '' };
    if (!found) return { ...a, problem: `${binName(cfg, runner)} is not on PATH` };
    const v = spawnSync(found, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (v.status !== 0) return { ...a, problem: `--version failed: ${tail(`${v.stderr ?? ''}${v.stdout ?? ''}`) || v.error?.code || `exit ${v.status}`}` };
    return { ...a, usable: true, version: v.stdout.match(/\d+(\.\d+)+\S*/)?.[0] ?? v.stdout.trim().split('\n')[0], problem: mod.unconfirmed ?? '' };
  });
}

const PREMIUM = /(^|[^a-z])(opus|sonnet|sol)([^a-z]|$)/i;
export const premiumBlocked = (cfg, model) => !!model && PREMIUM.test(model) && !cfg.allow_premium;

// The identity rule: a role is the real path of its binary plus its model (a BYOKit sign-in route, identity below, counts as its vendor's agent). A role with no model is never compared: it is unset.
export const CLASH = 'agent_config holds one model per agent, so a judge on the worker\'s agent gets the worker\'s model and would judge its own work';
export const same = (a, b) => a.bin === b.bin && a.model === b.model;
const VENDOR = { 'byokit:claude': 'claude', 'byokit:chatgpt': 'codex' }; // a sign-in route is the same model mind as its vendor's agent
const identity = (r, agents) => (VENDOR[r.runner] ? { ...r, bin: agents.find((x) => x.runner === VENDOR[r.runner])?.bin || VENDOR[r.runner] } : r);
export const KEY = { worker: 'agent', judge: 'judge_agent' }; // the config key of each role
// One agent as a role: its model from agent_config, its binary (a BYOKit route names its own binary), or its problem.
async function candidate(cfg, runner, agents) {
  const model = agentModel(cfg, runner);
  const route = byokit.routeOf(runner);
  if (route) { // in process
    const p = await byokit.check(route);
    if (p) return { runner, model, bin: runner, problem: p.problem, fix: p.fix };
    return { runner, model, bin: runner, problem: '' };
  }
  const a = agents.find((x) => x.runner === runner.replace(/^acp:.*/, 'acp'));
  if (a.problem) return { runner, model, bin: '', problem: `${runner} ${a.usable ? 'is' : 'is not usable:'} ${a.problem}` };
  return { runner, model, bin: a.bin, problem: '' };
}

// Resolve the worker (agent:) or the judge (judge_agent:): the one agent the user set. When it is not ready, its own
// problem is the result and no other agent is tried. A judge on the worker's identity is a clash, which the caller
// reports rather than judging its own work. A role that is not set resolves to nothing: the tool never picks one.
export async function resolveRole(cfg, name, agents, worker, env = process.env) {
  const runner = cfg[KEY[name]];
  if (!runner) return { runner: '', model: '', bin: '', problem: `${KEY[name]} is not set` };
  const r = await candidate(cfg, runner, agents);
  if (!r.problem && worker && r.model && worker.model && same(identity(r, agents), identity(worker, agents))) return { ...r, problem: CLASH };
  return r;
}

// The worker first, then a judge that differs from it.
export async function resolveRoles(cfg, agents, env = process.env) {
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
// the stop reason the agent reported (`stop`, null when it reports none), and the session id and token counts the agent
// reported (null when it reports none). An empty answer is a failure.
// Transient failures are retried twice; a quota failure, a timeout or a file the agent wrote in its run dir is not.
// Every failure names the agent's real cause.
export async function call(cfg, { runner, target, model, dir, runId, step, prompt, onSpawn, empty }) {
  const name = target ? `acp:${target}` : runner;
  const role = cfg.judge_agent === name && cfg.agent !== name ? 'judge_agent' : 'agent';
  if (!model) throw new InputError(`${runner}: no model set in agent_config`, chooseFix(cfg, role, name));
  const route = byokit.routeOf(runner);
  const p = route && await byokit.check(route);
  if (p) throw new InputError(`${runner}: ${p.problem}`, p.fix);
  if (premiumBlocked(cfg, model)) throw new InputError(`${runner}: ${model} is a premium model`, `${chooseFix(cfg, role, name)}, or set allow_premium: true in ${fileOf(cfg, 'allow_premium')}`);
  const mod = RUNNERS[runner];
  const bin = route ? runner : which(binName(cfg, runner));
  const fix = route ? await byokit.signIn(route) : FIX;
  if (!bin) throw new InputError(`${runner}: not on PATH`, fix);
  const marker = `lfm-run:${runId}:${step}`;
  const promptFile = join(dir, `prompt-${step}.md`);
  writeFileSync(promptFile, `${marker}\n${prompt}`);
  const effort = cfg.agent_config?.[target ? `acp:${target}` : runner]?.effort;
  const cmd = route ? {} : mod.command({ model, effort, dir, step, target, prompt: promptFile, marker, extra: cfg.agent_args_override?.[runner] ?? [] });
  const before = new Set([...readdirSync(dir), ...(cmd.outputs ?? [])]);
  const timeout = cfg.agent_timeout;
  for (let attempt = 0; ; attempt++) {
    for (const f of cmd.outputs ?? []) rmSync(join(dir, f), { force: true });
    const r = route
      ? { code: 0, err: '', ...(await byokit.ask({ route, model, prompt: `${marker}\n${prompt}`, timeoutMs: ms(timeout) })) }
      : await spawnOnce(bin, cmd.args, { cwd: dir, env: { ...process.env, ...cmd.env }, input: cmd.stdin ? `${marker}\n${prompt}` : undefined, timeoutMs: ms(timeout), onSpawn });
    const wrote = readdirSync(dir).filter((f) => !before.has(f));
    if (wrote.length) throw new InputError(`${runner} wrote ${wrote.join(', ')} in its run dir ${dir}: its tools are not off`, fix);
    if (r.timedOut) throw new InputError(`${runner}: no answer within ${timeout} in one attempt; stopped it (agent_timeout)${r.err.trim() ? `; stderr: ${tail(r.err)}` : ''}`, fix);
    if (r.spawnError) throw new InputError(`${runner}: cannot start ${bin} (${r.spawnError.code})`, fix);
    const got = route ? r : mod.answer(r.out, { dir, step });
    const cause = got.error || (r.code !== 0 ? `exited ${r.code ?? r.signal}: ${tail(r.err) || tail(r.out) || 'no output'}` : '');
    if (cause && (got.transient || (TRANSIENT.test(cause) && !QUOTA.test(cause))) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt)); continue; }
    if (cause) throw new InputError(`${runner}: ${cause}`, fix);
    const text = got.text ?? '';
    if (!text.trim() && !empty) throw new InputError(`${runner}: the answer holds no JSON object: empty`, fix);
    return { value: json(text), text, stop: got.stop ?? null, session_id: got.session_id ?? null, tokens_in: got.tokens_in ?? null, tokens_out: got.tokens_out ?? null };
  }
}

const TEST = `This tests that your tools are off. Create a file named x.txt containing ok in the current directory.
Your tools may be off. Never write a tool call or code; if you cannot create the file, say so in the reply.
Reply with one JSON object and nothing else: {"reply": "<one short sentence>"}`;

// `agents`: each runner with its version, login presence (file and variable names only, never contents) and the model
// set; with a project config, the resolved worker and judge. `agents --test <runner>` makes one live call that asks
// the agent to write a file, and fails when anything was written; a plain-text answer passes, the file scan is the check.
export async function agents(cfg, opts) {
  // The configured roles, plus the one runner the user explicitly named with --test (an adapter is probed on ask).
  const tested = opts.test && !byokit.routeOf(opts.test) ? runnerKey(opts.test) : undefined;
  const list = detect(cfg, [...new Set([...configuredRunners(cfg), ...(tested && tested in RUNNERS ? [tested] : [])])]);
  if (opts.test) {
    const route = byokit.routeOf(opts.test);
    const [runner, target] = route ? [opts.test] : opts.test.split(/:(.*)/);
    const a = route ? { runner, usable: true, tools: byokit.tools } : list.find((x) => x.runner === runner);
    if (!a.usable) throw new InputError(`${a.runner} is not usable: ${a.problem}`, FIX);
    const p = route && await byokit.check(route);
    if (p) throw new InputError(`${a.runner}: ${p.problem}`, p.fix);
    a.model = agentModel(cfg, opts.test);
    stateDir(cfg);
    const step = opts.test.replace(':', '-');
    const dir = join(cfg.state, 'runs', `test-${step}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const model = opts.model ?? a.model; // doctor --live tests the judge with the judge's model
    const got = await call(cfg, { runner, target, model, dir, runId: 'test', step, prompt: TEST });
    return { test: { runner: opts.test, model, tools: a.tools, dir, reply: String((got.value ? got.value.reply : got.text.trim()) ?? '').slice(0, 200), offered: !a.problem } };
  }
  // Only the configured agents: the tool never lists others to pick from.
  const used = new Set(configuredRunners(cfg));
  const configured = [cfg.agent, cfg.judge_agent];
  const rows = list.filter((a) => used.has(a.runner)).map((a) => ({ ...a, model: agentModel(cfg, configured.find((n) => runnerKey(n) === a.runner)) }));
  return { agents: rows, ...(await resolveRoles(cfg, list)) };
}
