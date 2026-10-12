// A retro run: one `runs` row and one `steps` row per step, saved in the run store and run in order
// in this process (`retro --foreground`). Each step writes its status, its error or its output.
import { buildReport, EmptyError, ingest, InputError, stateDir, UsageError, withContext } from '../bin/learn-from-mistakes-axi.mjs';
import { openStore } from './store.mjs';

const RUN = 'id, status, created_at, updated_at, error';
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

export async function retro(cfg) {
  stateDir(cfg);
  const db = await openStore(cfg.state, true);
  const now = iso(Date.now());
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO runs (status, created_at, updated_at) VALUES ('running', ?, ?)`).run(now, now);
  const names = Object.keys(STEPS);
  names.forEach((name, ord) => db.prepare(`INSERT INTO steps (run_id, name, ord, status) VALUES (?, ?, ?, 'pending')`).run(id, name, ord));
  const step = db.prepare('UPDATE steps SET status = ?, started_at = COALESCE(started_at, ?), completed_at = ?, error = ?, output_json = ? WHERE run_id = ? AND name = ?');
  let failed, error = null;
  for (const name of names) {
    step.run('running', iso(Date.now()), null, null, null, id, name);
    try {
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
  return show(db, id);
}

export async function status(cfg, opts) {
  const db = await openStore(cfg.state, false);
  const id = opts.run ? Number(opts.run) : db?.prepare('SELECT max(id) AS id FROM runs').get().id;
  if (!db || id == null) throw new EmptyError(`no saved runs in ${cfg.state}`, withContext('learn-from-mistakes-axi retro --foreground', 'ingest and report as a saved run', opts));
  if (!db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id)) throw new UsageError(`no run ${id}`, withContext('learn-from-mistakes-axi runs', 'the saved run ids', opts));
  return show(db, id);
}

export async function runs(cfg) {
  const db = await openStore(cfg.state, false);
  return { runs: db ? db.prepare(`SELECT ${RUN} FROM runs ORDER BY id DESC LIMIT 10`).all().map((r) => ({ ...r })) : [] };
}

function show(db, id) {
  return {
    run: { ...db.prepare(`SELECT ${RUN} FROM runs WHERE id = ?`).get(id) },
    steps: db.prepare('SELECT name, status, started_at, completed_at, error FROM steps WHERE run_id = ? ORDER BY ord').all(id).map((s) => ({ ...s })),
  };
}
