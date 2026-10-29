// tokens retro: where a window's tokens went, from the Claude Code and Pi session stores, read through the session
// readers in their tokens mode. Deterministic: no agent is called. The money follows turns times context size, so the
// nine causes it ranks are the levers on those two: the instruction floor every turn re-reads, tool output kept in
// context (and the oversized part of it), context kept above 200k, repeated identical polls, the turns that issued a
// failed call, subagent fan-out, and whole files read again (with no edit between, or after a compaction).
// A cause counts tokens, never text: its pointer is a transcript file:line and its worst sessions are ids.
// The causes overlap (a polling turn also re-reads the floor), so they rank, they do not add up.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '@toon-format/toon';
import { EmptyError, shq, stateDir, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { runDir } from '../run.mjs';
import * as claude from '../sessions/claude.mjs';
import * as pi from '../sessions/pi.mjs';
import { locked, openStore } from '../store.mjs';
import { BASH, pollKey, WORK } from './poll.mjs';

export const STORES = { claude, pi };
const DAY = 86_400_000, BIG = 20_000, CTX = 200_000, REBUILD = 20_000;
const FAILED = ['tool_error', 'nonzero_exit', 'test_fail'];
const READ = /^(?:Read|read)$/;
// Each cause: what it is, the change that moves it, and the metric that must move.
export const CAUSES = {
  floor: ['instruction floor re-read every turn', 'trim the skill listing, the instruction files and the session-start hook output', 'floor_tokens_median'],
  'tool-carry': ['tool output kept in context and re-read', 'ask for less output: quiet flags, head or tail, counts instead of lists', 'oversized_result_carry'],
  oversized: ['oversized tool output (over 20k chars) kept in context', 'cap big output: keep the head and tail, save the rest to a file', 'oversized_result_carry'],
  'ctx-over-200k': ['context kept above 200k', 'hand off or compact before 200k', 'ctx_over_200k_share'],
  polling: ['repeated identical polling commands', 'wait on an event instead of polling; tokens guard install blocks the third identical poll', 'poll_repeat_turns'],
  'failed-calls': ['turns that issued a failed tool call', 'fix the repeated failing command in AGENTS.md or a skill (the retro finds which)', 'failed_call_turn_cost'],
  'fan-out': ['subagent fan-out (each subagent pays its own floor)', 'fewer, larger subagent tasks', 'tokens_per_day'],
  reread: ['whole files read again with no edit between', 'read a line range, or keep notes, instead of the whole file again', 'tokens_per_day'],
  'reread-after-compaction': ['whole files read again after a compaction', 'say in the compaction summary what was read', 'tokens_per_day'],
};
export const METRICS = ['tokens_per_day', 'weighted_per_day', 'ctx_over_200k_share', 'floor_tokens_median', 'single_tool_turn_share',
  'poll_repeat_turns', 'oversized_result_carry', 'failed_call_turn_cost', 'prefix_rebuilds'];

// A window start: <n>d or <n>h back from now, or a YYYY-MM-DD day (UTC).
export function since(value = '14d', now = Date.now()) {
  const rel = /^([1-9]\d{0,3})([dh])$/.exec(value);
  const start = rel ? now - Number(rel[1]) * (rel[2] === 'd' ? DAY : DAY / 24) : /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(start) || start >= now) throw new UsageError(`--since ${JSON.stringify(value)} must be a time back like 14d or 36h, or a past day like 2026-10-01`, 'learn-from-mistakes-axi tokens retro --since 14d');
  return start;
}
export function agentsOf(value = 'claude,pi') {
  const list = [...new Set(value.split(',').map((a) => a.trim()))];
  if (!list.length || !list.every((a) => Object.hasOwn(STORES, a))) throw new UsageError(`--agents ${JSON.stringify(value)} must name session stores tokens reads: ${Object.keys(STORES).join(', ')}`, 'learn-from-mistakes-axi tokens retro --agents claude,pi');
  return list;
}

// Tokens as printed: 1.2B, 3.4M, 5.6k.
export const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const prompt = (r) => r.input + r.cache_write + r.cache_read;
// Cost in multiples of the input price: cache write 1.25 (5 minutes) or 2 (1 hour), cache read 0.1, output 5.
const weights = (r) => ({ input: r.input, cache_write: 1.25 * (r.cache_write - r.cache_write_1h) + 2 * r.cache_write_1h, cache_read: 0.1 * r.cache_read, output: 5 * r.output });
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function tally() {
  const agent = () => ({ sessions: 0, requests: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, tokens: 0 });
  return { agents: {}, agent, weighted: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, causes: Object.fromEntries(Object.keys(CAUSES).map((c) => [c, { tokens: 0, count: 0, by: {}, worst: null }])),
    floors: [], single: 0, over: 0, rebuilds: 0 };
}

// One session's events, in file order (a subagent file's after its parent's), into the window's tally. Each subagent
// file is its own context; a compaction starts a new one. A request counts when its time is in the window.
export function count(t, events, start) {
  const inWin = (e) => e.ts !== null && Date.parse(e.ts) >= start;
  const first = events[0], a = (t.agents[first.agent] ??= t.agent());
  const add = (cause, tokens, e, n = 1) => {
    if (!tokens && !n) return;
    const c = t.causes[cause];
    c.tokens += tokens; c.count += n;
    c.by[e.session_id] = (c.by[e.session_id] ?? 0) + tokens;
    if (!c.worst || tokens > c.worst.tokens) c.worst = { tokens, ref: e.ref };
  };
  const contexts = new Map();
  for (const e of events) if (e.kind !== 'session_start') { const k = e.sub ?? ''; if (!contexts.has(k)) contexts.set(k, []); contexts.get(k).push(e); }
  let any = false;
  for (const [sub, list] of contexts) {
    // The in-window requests after each point of a context's segment (the stretch between compactions).
    const later = [];
    let seg = 0;
    for (const e of list) { if (e.kind === 'compaction') seg += 1; else if (e.kind === 'request' && inWin(e)) later[seg] = (later[seg] ?? 0) + 1; }
    const requests = new Map(), calls = new Map(), polls = new Map(), reads = new Map();
    let floor = null, counted = false;
    seg = 0;
    const left = () => later[seg] ?? 0;
    const turn = (call) => { const r = requests.get(call?.req); return r && inWin(r) ? prompt(r) + r.output : 0; };
    for (const e of list) {
      if (e.kind === 'compaction') { seg += 1; polls.clear(); continue; }
      if (e.kind === 'request') {
        requests.set(e.id, e);
        const p = prompt(e), isFirst = floor === null;
        if (isFirst) floor = p;
        if (!inWin(e)) continue;
        if (!counted) { counted = true; t.floors.push(floor); } // the floor of a context the window holds
        later[seg] -= 1;
        any = true;
        a.requests += 1;
        for (const k of ['input', 'cache_write', 'cache_read', 'output']) a[k] += e[k];
        a.tokens += p + e.output;
        for (const [k, v] of Object.entries(weights(e))) t.weighted[k] += v;
        if (e.tools === 1) t.single += 1;
        if (!isFirst) add('floor', floor, e, 0);
        if (p > CTX) { t.over += 1; add('ctx-over-200k', p - CTX, e); }
        if (!isFirst && e.input + e.cache_write >= REBUILD) t.rebuilds += 1;
        if (sub) add('fan-out', p + e.output, e, 0);
        continue;
      }
      if (e.kind === 'tool_call') {
        calls.set(e.id, e);
        const key = BASH.test(e.tool) ? pollKey(e.command) : null;
        if (key) {
          const n = (polls.get(key) ?? 0) + 1;
          polls.set(key, n);
          if (n > 1 && inWin(e)) add('polling', turn(e), e);
        } else if (BASH.test(e.tool) || WORK.test(e.tool)) polls.clear();
        if (WORK.test(e.tool) && e.file) reads.delete(e.file);
        continue;
      }
      if (e.kind !== 'tool_result' || !inWin(e)) continue;
      const call = calls.get(e.call), carry = Math.ceil((e.chars ?? 0) / 4) * left();
      add('tool-carry', carry, e);
      if (e.chars > BIG) add('oversized', carry, e);
      if (FAILED.includes(e.signal)) add('failed-calls', turn(call), e);
      if (call && READ.test(call.tool) && call.file && call.full && e.status === 'ok') {
        if (reads.has(call.file)) add(reads.get(call.file) === seg ? 'reread' : 'reread-after-compaction', carry, e);
        reads.set(call.file, seg);
      }
    }
    if (sub && list.some((e) => e.kind === 'request' && inWin(e))) t.causes['fan-out'].count += 1;
  }
  if (any) a.sessions += 1;
  t.causes.floor.count += any ? 1 : 0;
}

// The read: each chosen store in its tokens mode, one session at a time, and what could not be read.
export async function read(agents, start) {
  const t = tally(), problems = [];
  for (const name of agents) {
    t.agents[name] ??= t.agent();
    const got = await STORES[name].read({ readFrom: start, keep: () => true, excerpt: () => '', skip: new Set(), tokens: true,
      each: (events) => count(t, events, start), problem: (e) => problems.push({ agent: name, path: e.path ?? STORES[name].root(), code: e.code ?? e.message }) });
    t.agents[name].skipped = got.skipped;
  }
  return { t, problems };
}

// The window's model: totals per agent, the money split, the ranked causes and the new metrics.
export function model(t, { start, now, agents }) {
  const days = (now - start) / DAY;
  const total = Object.values(t.agents).reduce((n, a) => n + a.tokens, 0), requests = Object.values(t.agents).reduce((n, a) => n + a.requests, 0);
  const money = Object.values(t.weighted).reduce((n, v) => n + v, 0);
  const share = Object.fromEntries(Object.entries(t.weighted).map(([k, v]) => [k, money ? Math.round((v / money) * 1000) / 10 : 0]));
  const causes = Object.entries(t.causes).map(([cause, c]) => ({ cause, what: CAUSES[cause][0], tokens: Math.round(c.tokens), count: c.count,
    worst_sessions: Object.entries(c.by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s).join(' '), pointer: c.worst?.ref ?? '',
    change: CAUSES[cause][1], metric: CAUSES[cause][2] }))
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count).map((c, i) => ({ rank: i + 1, ...c }));
  const c = (k) => t.causes[k];
  const metrics = {
    tokens_per_day: total / days, weighted_per_day: money / days,
    ctx_over_200k_share: requests ? t.over / requests : null, floor_tokens_median: median(t.floors),
    single_tool_turn_share: requests ? t.single / requests : null, poll_repeat_turns: c('polling').count,
    oversized_result_carry: c('oversized').tokens, failed_call_turn_cost: c('failed-calls').tokens, prefix_rebuilds: t.rebuilds,
  };
  return { schema: 'lfm-tokens.v1', since: new Date(start).toISOString(), days: Math.round(days * 10) / 10, agents, total, requests,
    by_agent: Object.fromEntries(Object.entries(t.agents).map(([k, v]) => [k, { ...v }])), cost_share_pct: share, causes, metrics };
}

export function firstLine(m, report) {
  const per = m.agents.map((a) => `${a} ${fmt(m.by_agent[a]?.tokens ?? 0)}`).join(', ');
  const top = m.causes.filter((c) => c.tokens > 0).slice(0, 3).map((c) => `${c.cause} ${fmt(c.tokens)}`).join(', ') || 'none';
  return `tokens: ${fmt(m.total)}/${m.days}d (${per}) · cache-read ${Math.round(m.cost_share_pct.cache_read)}% of cost · top: ${top} · report: ${report}`;
}

const round = (v) => (v === null ? 'n/a' : Math.round(v * 1000) / 1000);
// tokens.txt: in plain words, the money split first, then the ranked causes with their change and metric.
function text(m, previous, problems, line) {
  const out = [line, '', `1. Where the money went (${m.days} days since ${m.since.slice(0, 10)}, ${m.requests} requests, ${fmt(m.total)} tokens)`, ''];
  for (const a of m.agents) { const b = m.by_agent[a]; out.push(`- ${a}: ${b.sessions} sessions, ${b.requests} requests, ${fmt(b.tokens)} tokens (cache read ${fmt(b.cache_read)}, cache write ${fmt(b.cache_write)}, input ${fmt(b.input)}, output ${fmt(b.output)})${b.skipped ? `; ${b.skipped} records or paths skipped` : ''}`); }
  const s = m.cost_share_pct;
  out.push('', `Weighted by list price, cache reads are ${s.cache_read}% of the cost, cache writes ${s.cache_write}%, output ${s.output}% and fresh input ${s.input}%.`,
    'Each turn re-reads the context so far, so the cost follows turns times context size, not what the model writes: a shorter answer moves only the output share.',
    '', '2. Causes, ranked by tokens (they overlap, so they do not add up)', '');
  for (const c of m.causes) out.push(`${c.rank}. ${c.cause}: ${fmt(c.tokens)} tokens, ${c.count} times. ${c.what}.`, `   change: ${c.change}; metric: ${c.metric}`, ...(c.pointer ? [`   worst: ${c.worst_sessions}; example: ${c.pointer}`] : []));
  out.push('', '3. Numbers (this window, the last tokens retro)', '');
  for (const k of METRICS) out.push(`- ${k}: ${round(m.metrics[k])} (last: ${previous ? round(previous[k] ?? null) : 'n/a'})`);
  if (problems.length) out.push('', '4. Not read', '', ...problems.map((p) => `- ${p.agent}: ${p.path}: ${p.code}`));
  return `${out.join('\n')}\n`;
}

// `tokens retro`: reads, counts, saves a run (kind tokens) with its metrics in the run store when there is a project
// config, and writes tokens.txt and tokens.json there or in --out.
export async function retro(cfg, opts, now = Date.now()) {
  const start = since(opts.since, now), agents = agentsOf(opts.agents);
  if (!cfg && !opts.out) throw new UsageError(`no project config to keep the run in, and no --out`, 'learn-from-mistakes-axi tokens retro --out <dir>   # or run learn-from-mistakes-axi init first');
  const { t, problems } = await read(agents, start);
  const m = model(t, { start, now, agents });
  if (!m.requests) throw new EmptyError(`no ${agents.join(' or ')} requests since ${m.since.slice(0, 10)}${problems.length ? ` (${problems.length} paths not read)` : ''}`, 'learn-from-mistakes-axi tokens doctor   # which stores are readable');
  let id = null, previous = null, db;
  if (cfg) {
    stateDir(cfg);
    db = await openStore(cfg.state, true);
    const at = new Date(now).toISOString();
    id = locked(db, () => {
      const last = db.prepare(`SELECT max(id) AS id FROM runs WHERE kind = 'tokens' AND status = 'completed'`).get().id;
      if (last != null) previous = Object.fromEntries(db.prepare(`SELECT name, value FROM metrics WHERE run_id = ? AND window = 'current'`).all(last).map((r) => [r.name, r.value]));
      const run = Number(db.prepare(`INSERT INTO runs (status, created_at, updated_at, kind) VALUES ('completed', ?, ?, 'tokens')`).run(at, at).lastInsertRowid);
      const add = db.prepare('INSERT INTO metrics (run_id, window, name, value) VALUES (?, ?, ?, ?)');
      for (const k of METRICS) { add.run(run, 'current', k, m.metrics[k]); add.run(run, 'previous', k, previous?.[k] ?? null); }
      return run;
    });
  }
  const out = opts.out ?? runDir(cfg, id);
  try { mkdirSync(out, { recursive: true }); } catch (e) { db?.close(); throw new UsageError(`${out}: cannot create (${e.code})`, `learn-from-mistakes-axi tokens retro --out <dir>   # a dir it can write`); }
  const report = join(out, 'tokens.txt'), line = firstLine(m, report);
  writeFileSync(report, text(m, previous, problems, line));
  writeFileSync(join(out, 'tokens.json'), `${JSON.stringify({ ...m, run: id, previous, not_read: problems }, null, 2)}\n`);
  if (db) {
    locked(db, () => db.prepare(`INSERT INTO steps (run_id, name, ord, status, started_at, completed_at, output_json) VALUES (?, 'tokens', 0, 'completed', ?, ?, ?)`)
      .run(id, m.since, new Date(now).toISOString(), JSON.stringify({ summary: line, tokens_txt: report })));
    db.close();
  }
  return { line, model: { ...m, run: id, previous, not_read: problems }, report };
}

// The ranked table printed after the first line.
export const table = (m) => encode({ causes: m.causes.map(({ rank, cause, tokens, count, worst_sessions }) => ({ rank, cause, tokens: fmt(tokens), count, worst_sessions })) });

// `tokens doctor`: per store, whether it is there and readable, the sessions in the window it could open, and each path
// it could not list or read with the reason. It reads only the first PROBE lines of each session file, so it is quick
// on a large store; the retro reads them whole. It opens only the stores' session dirs and .jsonl files, never a login file.
const PROBE = 20;
export async function doctor(opts, now = Date.now()) {
  const start = since(opts.since, now), agents = agentsOf(opts.agents);
  const checks = [];
  for (const name of agents) {
    const store = STORES[name], root = store.root();
    if (!existsSync(root)) { checks.push({ level: 'warn', store: name, detail: `no store at ${root}`, fix: `export ${store.STORE_VAR}=<dir>   # if it is somewhere else, or drop ${name} from --agents` }); continue; }
    let st;
    try { st = statSync(root); readdirSync(root); } catch (e) {
      checks.push({ level: 'fail', store: name, detail: `cannot read ${root}: ${e.code}${st && !st.isDirectory() ? ' (not a directory)' : ''}`, fix: st && !st.isDirectory() ? `export ${store.STORE_VAR}=<the session dir>   # it points at a file` : `chmod -R u+rX ${shq(root)}   # the tool only reads it` });
      continue;
    }
    const problems = [];
    const got = await store.read({ readFrom: start, keep: () => true, excerpt: () => '', skip: new Set(), tokens: true, head: PROBE, each: () => {}, problem: (e) => problems.push(`${e.path ?? root}: ${e.code ?? e.message}`) });
    const detail = `${got.sessions} sessions readable since ${new Date(start).toISOString().slice(0, 10)} at ${root}${got.skipped ? `; ${got.skipped} records or paths skipped` : ''}`;
    checks.push(problems.length ? { level: 'fail', store: name, detail: `${detail}; not read: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}`, fix: `chmod -R u+rX ${shq(root)}   # the tool only reads it` }
      : { level: 'ok', store: name, detail });
  }
  return { line: checks.map((c) => `${c.store} ${c.level === 'ok' ? 'ok' : c.level === 'warn' ? 'missing' : 'unreadable'}`).join(' · '), checks, fails: checks.filter((c) => c.level === 'fail').length };
}
