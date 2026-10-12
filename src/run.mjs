// A retro run: one `runs` row and one `steps` row per step, saved in the run store. `retro` starts a
// detached worker (`_work`) that runs the steps in order, so the run goes on when the caller ends;
// `--foreground` runs them in this process. Each step writes its status, its error or its output.
// The process that owns a running run is saved as its pid and start time; a running run whose owner is
// gone is interrupted, and `rerun --resume` runs it again from its first step that is not completed.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, EmptyError, ingest, InputError, stateDir, UsageError, withContext } from '../bin/learn-from-mistakes-axi.mjs';
import { openStore } from './store.mjs';

const RUN = 'id, status, pid, created_at, updated_at, error';
const BIN = fileURLToPath(new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url));
const REPORT = 'learn-from-mistakes-axi report   # names each problem';
const STEPS = {
  collect: async (cfg) => ({ sources: await ingest(cfg) }),
  // Counts with the labels already in the state dir; with none, coverage shows every record unlabelled.
  report: (cfg) => {
    const { model, problems } = buildReport(cfg, {}, REPORT);
    if (problems.length) throw new InputError(`${problems.length} problems in the labels, proposals or change ledger`, REPORT);
    return model;
  },
};
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A process's start time tells it from a later process with the same pid; null when there is no such process.
function startTime(pid) {
  try {
    if (!existsSync('/proc/self/stat')) return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' '); // after "pid (comm) "
    return f[0] === 'Z' ? null : f[19]; // field 22, starttime; a zombie has already ended
  } catch { return null; }
}

// Ends a running run and its running step: interrupted (its owner is gone) or cancelled (a signal).
function stop(db, id, status, why) {
  const step = db.prepare(`SELECT name FROM steps WHERE run_id = ? AND status = 'running'`).get(id)?.name ?? 'run';
  const now = iso(Date.now());
  db.prepare(`UPDATE steps SET status = ?, completed_at = ? WHERE run_id = ? AND status = 'running'`).run(status, now, id);
  db.prepare('UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, `${step}: ${why}`, now, id);
}

function reconcile(db) {
  for (const r of db.prepare(`SELECT id, pid, pid_started_at FROM runs WHERE status = 'running'`).all()) {
    const started = r.pid && startTime(r.pid);
    if (!started || started !== r.pid_started_at) stop(db, r.id, 'interrupted', 'the worker stopped before the step ended');
  }
}

function blockRunning(db, opts) {
  const active = db.prepare(`SELECT id FROM runs WHERE status = 'running'`).get();
  if (active) throw new UsageError(`run ${active.id} is still running`, withContext(`learn-from-mistakes-axi status --run ${active.id}`, 'its steps so far', opts));
}

export async function retro(cfg, opts) {
  stateDir(cfg);
  const db = await openStore(cfg.state, true);
  reconcile(db);
  blockRunning(db, opts);
  const now = iso(Date.now());
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO runs (status, pid, pid_started_at, created_at, updated_at) VALUES ('running', ?, ?, ?, ?)`)
    .run(process.pid, startTime(process.pid), now, now); // this process owns the run until the worker does
  Object.keys(STEPS).forEach((name, ord) => db.prepare(`INSERT INTO steps (run_id, name, ord, status) VALUES (?, ?, ?, 'pending')`).run(id, name, ord));
  return start(cfg, db, id, opts);
}

export async function rerun(cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (db) reconcile(db);
  const id = pick(cfg, db, opts);
  const { status } = db.prepare('SELECT status FROM runs WHERE id = ?').get(id);
  if (status === 'completed') throw new UsageError(`run ${id} already completed`, withContext('learn-from-mistakes-axi retro --wait 8m', 'a new run', opts));
  blockRunning(db, opts);
  db.prepare(`UPDATE steps SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL, output_json = NULL WHERE run_id = ? AND status != 'completed'`).run(id);
  db.prepare(`UPDATE runs SET status = 'running', error = NULL, pid = ?, pid_started_at = ?, updated_at = ? WHERE id = ?`).run(process.pid, startTime(process.pid), iso(Date.now()), id);
  return start(cfg, db, id, opts);
}

// Runs the steps here (--foreground), or hands the run to a detached worker that outlives this process
// and, with --wait, polls the store until the run ends or the wait is over.
async function start(cfg, db, id, opts) {
  if (opts.foreground) { await work(cfg, db, id); return show(db, id); }
  const dir = join(cfg.state, 'runs', String(id));
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, 'worker.log'), 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, '_work', String(id), '--dir', cfg.dir],
    { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  db.prepare('UPDATE runs SET pid = ?, pid_started_at = ?, updated_at = ? WHERE id = ?').run(child.pid, startTime(child.pid), iso(Date.now()), id);
  for (const end = Date.now() + (opts.wait ?? 0); Date.now() < end; await sleep(250)) {
    reconcile(db);
    if (db.prepare('SELECT status FROM runs WHERE id = ?').get(id).status !== 'running') break;
  }
  return show(db, id);
}

// The hidden `_work <id>` command: the detached worker. A signal cancels the run; a kill leaves it for reconcile.
export async function worker(cfg, id) {
  const db = await openStore(cfg.state, false);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop(db, id, 'cancelled', `cancelled by ${sig}`); process.exit(1); });
  await work(cfg, db, id);
}

async function work(cfg, db, id) {
  const step = db.prepare('UPDATE steps SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, error = ?, output_json = ? WHERE run_id = ? AND name = ?');
  let failed, error = null;
  for (const { name } of db.prepare(`SELECT name FROM steps WHERE run_id = ? AND status != 'completed' ORDER BY ord`).all(id)) {
    step.run('running', iso(Date.now()), null, null, null, id, name);
    try {
      if (process.env.LFM_TEST_SLOW_STEP === name) await sleep(60_000); // set only by tests: a step slow enough to kill the worker in
      step.run('completed', null, iso(Date.now()), null, JSON.stringify(await STEPS[name](cfg)), id, name);
    } catch (e) {
      failed = e;
      error = `${name}: ${e.message}`;
      step.run('failed', null, iso(Date.now()), e.message, null, id, name);
      break;
    }
  }
  db.prepare('UPDATE runs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(failed ? 'failed' : 'completed', error, iso(Date.now()), id);
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
  if (db) reconcile(db);
  return show(db, pick(cfg, db, opts));
}

export async function runs(cfg) {
  const db = await openStore(cfg.state, false);
  if (db) reconcile(db);
  return { runs: db ? db.prepare(`SELECT ${RUN} FROM runs ORDER BY id DESC LIMIT 10`).all().map((r) => ({ ...r })) : [] };
}

function show(db, id) {
  return {
    run: { ...db.prepare(`SELECT ${RUN} FROM runs WHERE id = ?`).get(id) },
    steps: db.prepare('SELECT name, status, started_at, completed_at, error FROM steps WHERE run_id = ? ORDER BY ord').all(id).map((s) => ({ ...s })),
  };
}
