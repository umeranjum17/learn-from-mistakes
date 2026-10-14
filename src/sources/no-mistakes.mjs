// no-mistakes: failed pipeline steps from a no-mistakes state database, opened read-only. One fixed query; no user SQL.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { pathSource } from '../config.mjs';
import { inWindow } from '../metrics.mjs';
import { redact } from '../redact.mjs';
import { which } from '../runners/index.mjs';
import { roots } from './sessions.mjs';

export const validate = (s, where, dir) => ({ ...pathSource(s, where, dir), dir });
// The columns the read uses; a store without one is a no-mistakes version this one does not read.
const COLUMNS = { repos: ['id', 'working_path', 'upstream_url'], runs: ['id', 'repo_id', 'branch'],
  step_results: ['id', 'run_id', 'step_name', 'status', 'error', 'started_at', 'completed_at'] };
const missing = (db) => Object.entries(COLUMNS).flatMap(([t, cols]) => {
  const have = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  return cols.filter((c) => !have.has(c)).map((c) => `${t}.${c}`);
});
const UNKNOWN = (gone) => `unknown store schema (no ${gone.join(', ')})`;

// The git toplevel of the project dir (the dir itself outside git): the checkout both detect and read match.
const checkout = (dir) => {
  const bin = which('git');
  return realpathSync((bin && spawnSync(bin, ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout?.trim()) || dir);
};

// init: the no-mistakes store ($NM_HOME, else ~/.no-mistakes) when it has a repo row for this project, by its
// checkout path or its origin URL. A store that cannot be read throws its real cause.
export async function detect(dir) {
  const home = process.env.NM_HOME && resolve(process.env.NM_HOME);
  const path = join(home || join(homedir(), '.no-mistakes'), 'state.sqlite');
  if (!existsSync(path)) return;
  const bin = which('git');
  const git = (...args) => bin && spawnSync(bin, ['-C', dir, ...args], { encoding: 'utf8' }).stdout?.trim();
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const gone = missing(db);
    if (gone.length) throw new Error(UNKNOWN(gone));
    const row = db.prepare('SELECT 1 FROM repos WHERE working_path IN (SELECT value FROM json_each(?)) OR upstream_url = ? LIMIT 1')
      .get(JSON.stringify(roots(checkout(dir))), git('remote', 'get-url', 'origin') || null);
    if (row) return { gate: { type: 'no-mistakes', path: home ? path : '~/.no-mistakes/state.sqlite' } };
  } catch (e) {
    throw new Error(`${path}: not a readable no-mistakes store (${e.message})`);
  } finally { db?.close(); }
}

// doctor: readable, the failed steps in the window, and the ones with no time, which the window cannot place.
export async function doctor(source, entry, ctx) {
  const { rows } = await read(source, entry, ctx);
  const timed = rows.filter((r) => r.at);
  const inWin = timed.filter((r) => Date.parse(r.at) >= ctx.readFrom).length;
  return { level: 'ok', detail: `${rows.length} failed steps, ${inWin} in the window, ${rows.length - timed.length} skipped (no time)` };
}

// One store holds the runs of every repo no-mistakes gates, so only this repo's rows are read: a repo row whose
// checkout is this project's (the git toplevel detect matches) or one of its worktrees, or whose upstream URL is its origin.
// Its identity is the sha256 of the rows read, so it follows content, not file time. A row takes the first cause
// whose match rule names this source and whose error_contains is in its error; the error is kept redacted.
// node:sqlite is loaded here, and only here, so runs that never read a store never warn about it.
export async function read(source, { path, dir }, { causes = {}, project } = {}) {
  const fix = `set sources.${source}.path in ${shq(project)} to your no-mistakes state.sqlite, or remove that source`;
  if (!existsSync(path)) throw new UsageError(`source ${source}: no such file`, fix);
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path, { readOnly: true });
    const gone = missing(db);
    if (gone.length) throw new UsageError(`source ${source}: ${UNKNOWN(gone)}`, `update learn-from-mistakes-axi to read this no-mistakes version, or remove sources.${source} from ${shq(project)}`);
    const git = which('git'), origin = (git && spawnSync(git, ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim()) || null;
    const rows = db.prepare(`SELECT s.id, s.run_id, s.step_name, s.error, COALESCE(s.completed_at, s.started_at) AS t, r.branch
      FROM step_results s JOIN runs r ON r.id = s.run_id JOIN repos p ON p.id = r.repo_id
      WHERE s.status = 'failed' AND (p.working_path IN (SELECT value FROM json_each(?)) OR p.upstream_url = ?) ORDER BY t, s.id`).all(JSON.stringify(roots(checkout(dir))), origin);
    const tag = (error) => Object.entries(causes).find(([, c]) => c.match?.source === source && error.includes(c.match.error_contains))?.[0] ?? null;
    const out = rows.map((r) => ({ id: r.id, source, run: r.run_id, step: r.step_name, branch: r.branch,
      at: r.t ? new Date(r.t > 1e11 ? r.t : r.t * 1000).toISOString() : '', error: redact(r.error ?? ''), cause: tag(r.error ?? '') }));
    return { rows: out, hash: createHash('sha256').update(JSON.stringify(out)).digest('hex') };
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`source ${source}: not a readable no-mistakes store (${e.message})`, fix);
  } finally { db?.close(); }
}

// gate_failures: the failed steps in the window, and gate_failures:<step> for each step name that failed in the read range.
export const metricNames = ['gate_failures'];
export const metricRows = 'records';
export function metrics(rows, window) {
  const steps = inWindow(rows, window).map((r) => JSON.parse(r.data).step);
  const names = [...new Set(rows.map((r) => JSON.parse(r.data).step))].sort();
  return { gate_failures: steps.length, ...Object.fromEntries(names.map((s) => [`gate_failures:${s}`, steps.filter((x) => x === s).length])) };
}
