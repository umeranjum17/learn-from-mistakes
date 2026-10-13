// The run store: <state dir>/lfm.sqlite. node:sqlite is loaded on first open, so commands that never
// open the store never load it. The schema is an ordered list of migrations; PRAGMA user_version counts
// the applied ones, so a later change appends an entry and never edits an earlier one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, status TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS steps (run_id INTEGER NOT NULL REFERENCES runs(id), name TEXT NOT NULL, ord INTEGER NOT NULL,
    status TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT, output_json TEXT, PRIMARY KEY (run_id, name))`,
  // The process that owns a running run, and at most one running run per project. A run left running by
  // a foreground run before this entry has no owner, so it ends as interrupted.
  `ALTER TABLE runs ADD COLUMN pid INTEGER; ALTER TABLE runs ADD COLUMN pid_started_at TEXT;
    UPDATE steps SET status = 'interrupted' WHERE status = 'running';
    UPDATE runs SET status = 'interrupted', error = 'run: the worker stopped before the run ended' WHERE status = 'running';
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running ON runs(status) WHERE status = 'running'`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), agent TEXT NOT NULL,
    session_id TEXT NOT NULL, ts TEXT, kind TEXT NOT NULL, tool TEXT, status TEXT, exit_code INTEGER, signal TEXT, cause TEXT,
    ref TEXT NOT NULL, excerpt TEXT NOT NULL)`,
  // The items of the other sources: defect-log bullets and failed gate steps. Local only, like the state dir.
  `CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), source TEXT NOT NULL,
    ts TEXT, ref TEXT NOT NULL, cause TEXT, text TEXT NOT NULL)`,
  // Each metric in this window (current) and the last (previous); NULL is n/a.
  `CREATE TABLE IF NOT EXISTS metrics (run_id INTEGER NOT NULL REFERENCES runs(id), window TEXT NOT NULL, name TEXT NOT NULL, value NUMERIC,
    PRIMARY KEY (run_id, window, name))`,
  // The metric's target ("<op> <number>", NULL with none), kept as it was when the run ran.
  'ALTER TABLE metrics ADD COLUMN target TEXT',
  // A record's facts its source's metrics count, as JSON (a PR's merge time, rework and reverts); NULL for other records.
  'ALTER TABLE records ADD COLUMN data TEXT',
];

// Opens the store, or returns undefined when `create` is false and there is none yet (reads never create state).
export async function openStore(state, create) {
  const file = join(state, 'lfm.sqlite');
  if (!create && !existsSync(file)) return undefined;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  locked(db, () => { // read the version under the write lock, so two first opens never apply an entry twice
    for (let i = db.prepare('PRAGMA user_version').get().user_version; i < MIGRATIONS.length; i++) db.exec(`${MIGRATIONS[i]}; PRAGMA user_version = ${i + 1}`);
  });
  return db;
}

// Runs fn in one write transaction: another process waits (busy_timeout) until it commits or rolls back.
export function locked(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
