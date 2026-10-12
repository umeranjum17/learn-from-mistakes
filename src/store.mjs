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
    UPDATE runs SET status = 'interrupted', error = 'run: the worker stopped before the run ended' WHERE status = 'running';
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running ON runs(status) WHERE status = 'running'`,
];

// Opens the store, or returns undefined when `create` is false and there is none yet (reads never create state).
export async function openStore(state, create) {
  const file = join(state, 'lfm.sqlite');
  if (!create && !existsSync(file)) return undefined;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  const done = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = done; i < MIGRATIONS.length; i++) db.exec(`BEGIN; ${MIGRATIONS[i]}; PRAGMA user_version = ${i + 1}; COMMIT`);
  return db;
}
