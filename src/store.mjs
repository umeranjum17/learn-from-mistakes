// The run store: <state dir>/lfm.sqlite. node:sqlite is loaded on first open, so commands that never
// open the store never load it. The schema is an ordered list of migrations; PRAGMA user_version counts
// the applied ones, so a later change appends an entry and never edits an earlier one.
import { randomBytes } from 'node:crypto';
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
  // A record's facts its source's metrics count, as JSON (a PR's merge time, rework and reverts; a firstmate record's
  // kind and redacted tag; a failed gate row's step name); NULL for a record whose source counts no facts.
  'ALTER TABLE records ADD COLUMN data TEXT',
  // Each applied change's metric before and after it, its tripwire (NULL with none) and the verdict the followup step gave.
  `CREATE TABLE IF NOT EXISTS followups (run_id INTEGER NOT NULL REFERENCES runs(id), change_id TEXT NOT NULL, metric TEXT NOT NULL,
    before NUMERIC, after NUMERIC, tripwire TEXT, verdict TEXT NOT NULL, PRIMARY KEY (run_id, change_id))`,
  // The id the labels and proposals take: a store-salted HMAC of the text for a defect-log record, source:id for a gate row or PR.
  'ALTER TABLE records ADD COLUMN record_id TEXT',
  // Each call to the run's own agent: its step and role, the agent CLI and model, its process group while it runs, how it
  // ended (ok, invalid, error, or the run's cancelled or interrupted), and the session id and tokens the agent reported.
  `CREATE TABLE IF NOT EXISTS invocations (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), step TEXT NOT NULL,
    role TEXT NOT NULL, runner TEXT NOT NULL, model TEXT NOT NULL, child_pgid INTEGER, child_started_at TEXT, session_id TEXT, marker TEXT NOT NULL,
    started_at TEXT NOT NULL, completed_at TEXT, exit_status TEXT, tokens_in INTEGER, tokens_out INTEGER)`,
  // The analyse step's label for each defect record it read: event, cause and why.
  `CREATE TABLE IF NOT EXISTS labels (run_id INTEGER NOT NULL REFERENCES runs(id), record_id TEXT NOT NULL, event INTEGER NOT NULL,
    cause TEXT, why TEXT NOT NULL, duplicate_of TEXT, occurrences INTEGER, confidence TEXT, PRIMARY KEY (run_id, record_id))`,
  // The causes and hidden problems the analyse step found, each with refs to bundle items. Later steps count and judge them.
  `CREATE TABLE IF NOT EXISTS findings (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), cause TEXT NOT NULL,
    summary TEXT NOT NULL, refs_json TEXT NOT NULL, count INTEGER, days INTEGER, verdict TEXT, judge_note TEXT)`,
  // The fixes the propose step's worker named, in its order (id), and what the check step made of each: its rank n among
  // the kept fixes (1 to 5, NULL when not kept) or the rule it broke (problem). And the worker's reason for each follow-up
  // whose verdict is not keep.
  `CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), n INTEGER, cause TEXT NOT NULL,
    target TEXT NOT NULL, owner TEXT NOT NULL, change TEXT NOT NULL, metric TEXT, tripwire TEXT, refs_json TEXT NOT NULL, problem TEXT);
    ALTER TABLE followups ADD COLUMN reason TEXT`,
  // The verify-fixes step's judge verdict on each fix (confirmed, weakened or refuted) and its reason.
  'ALTER TABLE proposals ADD COLUMN verdict TEXT; ALTER TABLE proposals ADD COLUMN judge_note TEXT',
  `ALTER TABLE proposals ADD COLUMN kind TEXT;
    CREATE TABLE IF NOT EXISTS signoff (proposal_id INTEGER PRIMARY KEY REFERENCES proposals(id), message TEXT NOT NULL, answer TEXT)`,
  // The key of a defect-log or done-done record's id, made once per store and never printed: a defect-log id is an
  // HMAC of the record's text, so whoever reads a bundle cannot hash a guessed text to it. A run from before this
  // entry keeps its plain-hash ids.
  () => `CREATE TABLE IF NOT EXISTS secret (salt BLOB NOT NULL); INSERT INTO secret VALUES (X'${randomBytes(32).toString('hex')}')`,
  // A session event whose test_fail only the tool output's own test-runner summary line showed: the error flag and the
  // exit code had stayed green (`npm test | tail` exits 0), so the output is the proof. See src/sessions/claude.mjs.
  'ALTER TABLE events ADD COLUMN from_output INTEGER NOT NULL DEFAULT 0',
  // When a run last discarded: a failed or cancelled attempt keeps no verdict, and the cap counts the attempt's agent
  // calls only, so a resume is never refused for the calls a discarded attempt made. The rows stay: a source that reads
  // sessions skips the ones the run's own agents held.
  'ALTER TABLE runs ADD COLUMN discarded_at TEXT',
];

// Opens the store, or returns undefined when `create` is false and there is none yet (reads never create state).
export async function openStore(state, create) {
  const file = join(state, 'lfm.sqlite');
  if (!create && !existsSync(file)) return undefined;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL');
  // A current store needs no write lock to open; else re-read the version under it, so two first opens never apply an entry twice.
  if (db.prepare('PRAGMA user_version').get().user_version < MIGRATIONS.length) locked(db, () => {
    for (let i = db.prepare('PRAGMA user_version').get().user_version; i < MIGRATIONS.length; i++) {
      const entry = MIGRATIONS[i];
      db.exec(`${typeof entry === 'function' ? entry() : entry}; PRAGMA user_version = ${i + 1}`);
    }
  });
  return db;
}

// Runs fn in one write transaction: another process waits (busy_timeout) until it commits or rolls back.
export function locked(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
