// A retro run: one `runs` row and one `steps` row per step, saved in the run store. `retro` starts a
// detached worker (`_work`) that runs the steps in order, so the run goes on when the caller ends;
// `--foreground` runs them in this process. Each step writes its status, its error or its output.
// The process that owns a running run is saved as its pid and start time; a running run whose owner is
// gone is interrupted, and `rerun --resume` runs it again from its first step that is not completed.
// Each step writes its lines to <state dir>/runs/<id>/<step>.log; `attach` follows them and `logs` prints one.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, EmptyError, ingest, InputError, recordId, sourceLine, stateDir, summaryLine, UsageError, withContext } from '../bin/learn-from-mistakes-axi.mjs';
import { bundle } from './bundle.mjs';
import { analyse } from './steps/analyse.mjs';
import { propose } from './steps/propose.mjs';
import { verify } from './steps/verify.mjs';
import { check } from './check.mjs';
import { followup } from './followup.mjs';
import { meets, metrics, rounded } from './metrics.mjs';
import { startTime } from './proc.mjs';
import { locked, openStore } from './store.mjs';

const RUN = 'id, status, pid, created_at, updated_at, error';
const BIN = fileURLToPath(new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url));
const REPORT = 'learn-from-mistakes-axi report   # names each problem';
const STEPS = {
  // Reads the sources: session events go to the `events` table, defect-log bullets, failed gate and verify steps and PRs to `records`,
  // each with the cause its source tagged it with. It can run again: it first drops the run's events and records.
  collect: async (cfg, db, id, log) => {
    const { sources, events, records, rows, prs, read_from, current_start, previous_start } = await ingest(cfg);
    for (const s of sources) log(sourceLine(s, false));
    const add = db.prepare(`INSERT INTO events (run_id, agent, session_id, ts, kind, tool, status, exit_code, signal, cause, ref, excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const record = db.prepare('INSERT INTO records (run_id, source, ts, ref, cause, text, data, record_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM events WHERE run_id = ?').run(id);
      db.prepare('DELETE FROM records WHERE run_id = ?').run(id);
      for (const e of events) add.run(id, e.agent, e.session_id, e.ts, e.kind, e.tool ?? null, e.status ?? null, e.exit_code ?? null, e.signal ?? null, e.cause ?? null, e.ref, e.excerpt);
      for (const r of records) record.run(id, r.source, r.date || null, r.ref ?? `${cfg.sources[r.source].path}:${r.line}`, null, r.text, null, r.id);
      for (const r of rows) record.run(id, r.source, r.at || null, `db:step_results:${r.id}`, r.cause, r.error, null, recordId(r));
      for (const r of prs) record.run(id, r.source, r.ts, r.ref, null, r.text, JSON.stringify(r.data), recordId(r));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { read_from, current_start, previous_start, sources };
  },
  // The numbers for this window and the last, over what collect saved.
  metrics: (cfg, db, id) => metrics(cfg, db, id, collected(db, id)),
  // Each applied change's metric before and after it, and a verdict: keep, fix, rollback, delete or no-data.
  followup: (cfg, db, id, log) => followup(cfg, db, id, collected(db, id), log),
  // The file the run's agents read: <run dir>/bundle.md, with its counts in the step log.
  bundle: (cfg, db, id, log) => {
    const out = bundle(cfg, db, id, join(runDir(cfg, id), 'bundle.md'), collected(db, id));
    log(`bundle.md: ${out.items} items, ${out.dropped} dropped, ${out.chars} characters`);
    return out;
  },
  // The worker reads the bundle: it names the causes it finds and labels the defect records (the labels and findings tables).
  analyse: (cfg, db, id, log) => analyse(cfg, db, id, runDir(cfg, id), log),
  // The worker proposes fixes for the repeated causes and gives the reason for each follow-up that is not keep.
  propose: (cfg, db, id, log) => propose(cfg, db, id, runDir(cfg, id), collected(db, id), log),
  // The judge tries to refute each finding and fix against the bundle items it cites: confirmed, weakened or refuted.
  verify: (cfg, db, id, log) => verify(cfg, db, id, runDir(cfg, id), log),
  // Keeps only the fixes that follow the rules: ranked, at most five, numbered for `change applied --proposal <run>:<n>`.
  check: (cfg, db, id, log) => check(cfg, db, id, runDir(cfg, id), collected(db, id), log),
  // Counts with the labels the worker kept in this run when the worker was asked, else with labels.jsonl in the state dir;
  // with none, coverage shows every record unlabelled.
  report: (cfg, db, id, log) => {
    const analysed = db.prepare(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'analyse'`).get(id)?.output_json;
    const runLabels = analysed && JSON.parse(analysed).asked ? db.prepare('SELECT record_id, event, cause, why, duplicate_of, occurrences, confidence FROM labels WHERE run_id = ?').all(id)
      .map(({ record_id, event, ...r }, i) => ({ id: record_id, event: Boolean(event), _line: i + 1,
        ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) })) : undefined; // NULL is an unset field
    const { model, problems } = buildReport(cfg, { runLabels }, REPORT);
    if (problems.length) throw new InputError(`${problems.length} problems in the labels, proposals or change ledger`, REPORT);
    log(summaryLine(model));
    return model;
  },
};
const collected = (db, id) => JSON.parse(db.prepare(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'collect'`).get(id).output_json);
const runDir = (cfg, id) => join(cfg.state, 'runs', String(id));
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ends a running run and its running step: interrupted (its owner is gone) or cancelled (a signal). An agent call the
// run left going is ended too: its process group gets SIGTERM, then SIGKILL once its leader has gone or after 3 s.
function stop(db, id, status, why) {
  const step = db.prepare(`SELECT name FROM steps WHERE run_id = ? AND status = 'running'`).get(id)?.name ?? 'run';
  const now = iso(Date.now());
  for (const { child_pgid: g, child_started_at: t } of db.prepare('SELECT child_pgid, child_started_at FROM invocations WHERE run_id = ? AND completed_at IS NULL AND child_pgid IS NOT NULL').all(id)) {
    if (!t || startTime(g) !== t) continue; // the group's leader is gone or another process; a group whose leader exited is left (a grandchild may hold it)
    if (!signal(g, 'SIGTERM')) continue;
    for (let i = 0; i < 30 && startTime(g) === t; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // a synchronous 100 ms wait
    signal(g, 'SIGKILL');
  }
  db.prepare('UPDATE invocations SET completed_at = ?, exit_status = ? WHERE run_id = ? AND completed_at IS NULL').run(now, status, id);
  db.prepare(`UPDATE steps SET status = ?, completed_at = ? WHERE run_id = ? AND status = 'running'`).run(status, now, id);
  db.prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(status, `${step}: ${why}`, now, id);
}

// Sends a signal to a process group; false when the group is gone.
function signal(pgid, sig) {
  try { process.kill(-pgid, sig); return true; } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw new UsageError(`cannot send ${sig} to the agent's process group ${pgid} (${e.code})`, `kill -- -${pgid}   # as the user that started the run`);
  }
}

function reconcile(db) {
  for (const r of db.prepare(`SELECT id, pid, pid_started_at FROM runs WHERE status = 'running'`).all()) {
    const started = r.pid && startTime(r.pid);
    if (!started || started !== r.pid_started_at) stop(db, r.id, 'interrupted', 'the worker stopped before the step ended');
  }
}

function blockRunning(db, opts) {
  const active = db.prepare(`SELECT id FROM runs WHERE status = 'running'`).get();
  if (active) throw new UsageError(`run ${active.id} is still running`, withContext(`learn-from-mistakes-axi attach --run ${active.id}`, `follow it to the end, or abort --run ${active.id} to stop it`, opts));
}

export async function retro(cfg, opts) {
  stateDir(cfg);
  const db = await openStore(cfg.state, true);
  const id = locked(db, () => {
    reconcile(db);
    blockRunning(db, opts);
    const now = iso(Date.now());
    const { lastInsertRowid } = db.prepare(`INSERT INTO runs (status, pid, pid_started_at, created_at, updated_at) VALUES ('running', ?, ?, ?, ?)`)
      .run(process.pid, startTime(process.pid), now, now); // this process owns the run until the worker takes it
    dropRunDir(cfg, lastInsertRowid);
    Object.keys(STEPS).forEach((name, ord) => db.prepare(`INSERT INTO steps (run_id, name, ord, status) VALUES (?, ?, ?, 'pending')`).run(lastInsertRowid, name, ord));
    return lastInsertRowid;
  });
  return start(cfg, db, id, opts);
}

// `rerun --resume` runs a run again from its first step that is not completed; a plain `rerun` starts a new
// run with the current config, and returns the run it was started from.
export async function rerun(cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (!db || !opts.resume) { const from = pick(cfg, db, opts); return { ...await retro(cfg, opts), from }; } // pick throws: no saved runs, or no such run
  const id = locked(db, () => {
    reconcile(db);
    const id = pick(cfg, db, opts);
    const { status } = db.prepare('SELECT status FROM runs WHERE id = ?').get(id);
    if (status === 'completed') throw new UsageError(`run ${id} already completed`, withContext('learn-from-mistakes-axi retro --wait 8m', 'a new run', opts));
    blockRunning(db, opts);
    const reset = db.prepare(`SELECT name FROM steps WHERE run_id = ? AND status != 'completed'`).all(id).map((s) => s.name);
    db.prepare(`UPDATE steps SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL, output_json = NULL WHERE run_id = ? AND status != 'completed'`).run(id);
    for (const name of reset) dropLog(cfg, id, name);
    db.prepare(`UPDATE runs SET status = 'running', error = NULL, pid = ?, pid_started_at = ?, updated_at = ? WHERE id = ?`).run(process.pid, startTime(process.pid), iso(Date.now()), id);
    return id;
  });
  return start(cfg, db, id, opts);
}

// Runs the steps here (--foreground), or hands the run to a detached worker that outlives this process
// and, with --wait, polls the store until the run ends or the wait is over.
async function start(cfg, db, id, opts) {
  if (opts.foreground) { await work(cfg, db, id); return show(db, id); }
  const dir = runDir(cfg, id);
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, 'worker.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, '_work', String(id), String(process.pid), '--dir', cfg.dir],
    { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  const failed = await new Promise((r) => { child.once('spawn', () => r()); child.once('error', r); });
  if (failed) {
    locked(db, () => db.prepare(`UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(`run: cannot start the worker (${failed.code ?? failed.message})`, iso(Date.now()), id));
    return show(db, id);
  }
  child.unref();
  // Hand the run to the worker unless it has already taken it. Each read and write here is in the write lock, so the
  // worker's own writes never meet a half-done one.
  locked(db, () => db.prepare('UPDATE runs SET pid = ?, pid_started_at = ?, updated_at = ? WHERE id = ? AND pid = ?').run(child.pid, startTime(child.pid), iso(Date.now()), id, process.pid));
  for (const end = Date.now() + (opts.wait ?? 0); Date.now() < end; await sleep(250)) {
    if (locked(db, () => { reconcile(db); return db.prepare('SELECT status FROM runs WHERE id = ?').get(id).status; }) !== 'running') break;
  }
  return show(db, id);
}

// The hidden `_work <id> <owner pid>` command: the detached worker. It takes the run from the process that
// started it, and leaves alone a run that ended or that another worker owns. A signal is handled between
// steps: a synchronous step finishes first, and a run that already ended is left as it is. A kill leaves it
// for reconcile.
export async function worker(cfg, id, owner) {
  const db = await openStore(cfg.state, false);
  const taken = db?.prepare(`UPDATE runs SET pid = ?, pid_started_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND pid IN (?, ?)`)
    .run(process.pid, startTime(process.pid), iso(Date.now()), id, owner, process.pid).changes;
  if (!taken) throw new UsageError(`run ${id} is not running, or another process owns it`);
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (!db.prepare(`SELECT 1 FROM runs WHERE id = ? AND status = 'running'`).get(id)) return;
      stop(db, id, 'cancelled', `cancelled by ${sig}`);
      process.exit(1);
    });
  }
  await work(cfg, db, id);
}

// Runs the steps that are not completed, in order. A run that ended meanwhile (abort marked it cancelled)
// runs no further step and keeps its status.
async function work(cfg, db, id) {
  const step = db.prepare('UPDATE steps SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, error = ?, output_json = ? WHERE run_id = ? AND name = ?');
  const running = db.prepare(`SELECT 1 FROM runs WHERE id = ? AND status = 'running'`);
  const [slow, slowMs = 60_000] = (process.env.LFM_TEST_SLOW_STEP ?? '').split(':'); // set only by tests: <step>[:<ms>]
  mkdirSync(runDir(cfg, id), { recursive: true });
  let failed, error = null;
  for (const { name } of db.prepare(`SELECT name FROM steps WHERE run_id = ? AND status != 'completed' ORDER BY ord`).all(id)) {
    if (!running.get(id)) return;
    const file = join(runDir(cfg, id), `${name}.log`);
    writeFileSync(file, ''); // the log holds the step's latest attempt
    const log = (line) => appendFileSync(file, `${line}\n`);
    step.run('running', iso(Date.now()), null, null, null, id, name);
    try {
      if (slow === name) await sleep(Number(slowMs));
      const out = JSON.stringify(await STEPS[name](cfg, db, id, log)); // before the completed time is read
      step.run('completed', null, iso(Date.now()), null, out, id, name);
    } catch (e) {
      failed = e;
      error = `${name}: ${e.message}`;
      log(`error: ${e.message}`);
      step.run('failed', null, iso(Date.now()), e.message, null, id, name);
      break;
    }
  }
  db.prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = 'running'`).run(failed ? 'failed' : 'completed', error, iso(Date.now()), id);
  if (failed && !(failed instanceof UsageError)) throw failed; // a bug, not a run outcome: keep its stack
}

function pick(cfg, db, opts) {
  const id = opts.run ? Number(opts.run) : db?.prepare('SELECT max(id) AS id FROM runs').get().id;
  if (!db || id == null) throw new EmptyError(`no saved runs in ${cfg.state}`, withContext('learn-from-mistakes-axi retro --wait 8m', 'ingest and report as a saved run', opts));
  if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id)) throw new UsageError(`no run ${id}`, withContext('learn-from-mistakes-axi runs', 'the saved run ids', opts));
  return id;
}

export async function status(cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (db) locked(db, () => reconcile(db));
  return show(db, pick(cfg, db, opts));
}

// `attach`: prints each step's state changes and new log lines until the run ends, polling every second.
export async function attach(cfg, opts) {
  const print = opts.json ? console.error : console.log; // --json keeps stdout one JSON document
  const db = await openStore(cfg.state, false);
  const id = pick(cfg, db, opts);
  const seen = {}; // step name -> the status and the count of log lines already printed
  for (;;) {
    locked(db, () => reconcile(db));
    const ended = db.prepare('SELECT status FROM runs WHERE id = ?').get(id).status !== 'running'; // read before the steps: none of their lines is missed
    for (const s of db.prepare('SELECT name, status FROM steps WHERE run_id = ? ORDER BY ord').all(id)) {
      const was = seen[s.name] ??= { status: 'pending', lines: 0 };
      const changed = s.status !== was.status;
      if (changed && s.status === 'running') print(`${s.name}: running`);
      const lines = logLines(cfg, id, s.name);
      for (const line of lines.slice(was.lines)) print(`${s.name}: ${line}`);
      if (changed && s.status !== 'running') print(`${s.name}: ${s.status}`);
      Object.assign(was, { status: s.status, lines: lines.length });
    }
    if (ended) return show(db, id);
    await sleep(1000);
  }
}

// A new run takes an id that an earlier run may have had once the store was removed: its logs go with it.
function dropRunDir(cfg, id) {
  const dir = runDir(cfg, id);
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {
    throw new UsageError(`${dir}: cannot remove (${e.code})`, `rm -r ${dir}   # the logs of an earlier run with this id`);
  }
}

// A step that is run again starts with no lines: the log of its failed attempt is removed.
function dropLog(cfg, id, name) {
  const file = join(runDir(cfg, id), `${name}.log`);
  try { rmSync(file, { force: true }); } catch (e) {
    throw new UsageError(`${file}: cannot remove (${e.code})`, `rm ${file}   # the step log of the attempt that is run again`);
  }
}

// A step's whole log lines (none before it starts); a line still being written is left for the next read.
function logLines(cfg, id, name) {
  const file = join(runDir(cfg, id), `${name}.log`);
  try { return readFileSync(file, 'utf8').split('\n').slice(0, -1); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new UsageError(`${file}: cannot read (${e.code})`, `chmod u+r ${file}   # the step log`);
  }
}

export async function logs(cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (db) locked(db, () => reconcile(db));
  const id = pick(cfg, db, opts);
  const step = db.prepare('SELECT name, status FROM steps WHERE run_id = ? AND name = ?').get(id, opts.step);
  if (!step) {
    const names = db.prepare('SELECT name FROM steps WHERE run_id = ? ORDER BY ord').all(id).map((s) => s.name).join(', ');
    throw new UsageError(`run ${id} has no step "${opts.step}" (steps: ${names})`, withContext(`learn-from-mistakes-axi logs --step collect --run ${id}`, 'one of its steps', opts));
  }
  const lines = logLines(cfg, id, step.name);
  return { step: step.name, run: id, status: step.status, lines: `${lines.length} total`, log: lines.map((line) => ({ line })) };
}

// `abort`: SIGTERM to the worker, whose trap marks the run cancelled, then the run is marked cancelled here
// too. A worker inside a long synchronous step reads the signal only after it, so after 3 s it gets SIGKILL.
export async function abort(cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (db) locked(db, () => reconcile(db));
  const id = opts.run || !db ? pick(cfg, db, opts) : db.prepare(`SELECT id FROM runs WHERE status = 'running'`).get()?.id;
  if (id == null) throw new UsageError('no run is running', withContext('learn-from-mistakes-axi runs', 'the saved runs', opts));
  const r = db.prepare('SELECT status, pid, pid_started_at FROM runs WHERE id = ?').get(id);
  if (r.status !== 'running') throw new UsageError(`run ${id} is not running (${r.status})`, withContext('learn-from-mistakes-axi runs', 'the saved runs', opts));
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    if (startTime(r.pid) !== r.pid_started_at) break; // the worker has ended, or the pid is now another process
    try { process.kill(r.pid, sig); } catch (e) {
      if (e.code !== 'ESRCH') throw new UsageError(`run ${id}: cannot send ${sig} to its worker, pid ${r.pid} (${e.code})`, `kill ${r.pid}   # as the user that started the run`);
    }
    for (let i = 0; i < 30 && startTime(r.pid) === r.pid_started_at; i++) await sleep(100);
  }
  locked(db, () => {
    stop(db, id, 'cancelled', 'cancelled by abort');
    const { status } = db.prepare('SELECT status FROM runs WHERE id = ?').get(id);
    if (status !== 'cancelled') throw new UsageError(`run ${id} is not running (${status})`, withContext('learn-from-mistakes-axi runs', 'the saved runs', opts));
  });
  return show(db, id);
}

export async function runs(cfg) {
  const db = await openStore(cfg.state, false);
  if (db) locked(db, () => reconcile(db));
  return { runs: db ? db.prepare(`SELECT ${RUN} FROM runs ORDER BY id DESC LIMIT 10`).all().map((r) => ({ ...r })) : [] };
}

// The run, its steps, what each source read once collect is done, the numbers once metrics is done and each
// applied change's verdict once followup is done, and the kept fixes once check is done: ids, counts and numbers, never
// content or hashes.
function show(db, id) {
  const out = (step) => db.prepare('SELECT output_json FROM steps WHERE run_id = ? AND name = ?').get(id, step)?.output_json;
  const collect = out('collect'), window = out('metrics');
  const metrics = new Map();
  // A metric with a target shows it and whether this window met it; one without has both empty.
  for (const m of db.prepare('SELECT window, name, value, target FROM metrics WHERE run_id = ? ORDER BY rowid').all(id)) {
    if (!metrics.has(m.name)) metrics.set(m.name, { name: m.name, current: 'n/a', previous: 'n/a', target: '', met: '' });
    const row = metrics.get(m.name);
    row[m.window] = rounded(m.value); // the verdict uses the unrounded value
    if (m.window === 'current') Object.assign(row, { target: m.target ?? '', met: !m.target ? '' : m.value === null ? 'n/a' : meets(m.value, m.target) ? 'met' : 'missed' });
  }
  return {
    run: { ...db.prepare(`SELECT ${RUN} FROM runs WHERE id = ?`).get(id) },
    steps: db.prepare('SELECT name, status, started_at, completed_at, error FROM steps WHERE run_id = ? ORDER BY ord').all(id).map((s) => ({ ...s })),
    ...(collect && { sources: JSON.parse(collect).sources.map(({ hash, ...s }) => s) }),
    ...(window && { window: JSON.parse(window), metrics: [...metrics.values()] }),
    ...(out('followup') && { followups: db.prepare('SELECT change_id, metric, before, after, tripwire, verdict FROM followups WHERE run_id = ? ORDER BY rowid').all(id)
      .map((f) => ({ change: f.change_id, metric: f.metric, before: rounded(f.before), after: rounded(f.after), tripwire: f.tripwire ?? '', verdict: f.verdict })) }),
    ...(out('check') && { fixes: db.prepare('SELECT n, cause, metric, tripwire FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n').all(id).map((f) => ({ ...f })) }),
  };
}
