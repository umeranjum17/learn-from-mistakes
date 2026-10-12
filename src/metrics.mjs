// The metrics step: the numbers for this window (current) and the last (previous), from the events and records
// collect saved for the run. Each source gives its own numbers (its metrics(rows, window)); cause_count:<cause>
// counts the items collect tagged with that cause. A metric with no source to give it is n/a (NULL), never 0.
import { SOURCES } from './config.mjs';

// The rows whose time is in the window: from its start, and before its end when it has one.
export const inWindow = (rows, { start, end = Infinity }) => rows.filter((r) => { const t = Date.parse(r.ts); return t >= start && t < end; });

// The current window has no end, so an event the clock puts a little after the read still counts.
export function metrics(cfg, db, id, { current_start, previous_start }) {
  const windows = { current: { start: Date.parse(current_start) }, previous: { start: Date.parse(previous_start), end: Date.parse(current_start) } };
  const events = db.prepare('SELECT session_id, ts, kind, tool, signal, cause FROM events WHERE run_id = ?').all(id);
  const records = db.prepare('SELECT source, ts, cause FROM records WHERE run_id = ?').all(id);
  const add = db.prepare('INSERT INTO metrics (run_id, window, name, value) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM metrics WHERE run_id = ?').run(id);
    for (const [window, w] of Object.entries(windows)) {
      const v = {};
      // ponytail: two sources of one type give the same names; the last one wins. Sum or prefix them if a project needs both.
      for (const [sid, s] of Object.entries(cfg.sources)) Object.assign(v, SOURCES[s.type].metrics?.(s.type === 'sessions' ? events : records.filter((r) => r.source === sid), w));
      for (const [cause, c] of Object.entries(cfg.causes)) {
        // n/a with no match rule, or when the rule's sessions source has no session in the window (as its other counts)
        const read = c.match && (cfg.sources[c.match.source].type !== 'sessions' || inWindow(events, w).length);
        v[`cause_count:${cause}`] = read ? inWindow([...events, ...records].filter((r) => r.cause === cause), w).length : null;
      }
      for (const name of Object.keys(cfg.targets)) v[name] ??= null; // a target no source measures
      for (const [name, value] of Object.entries(v)) add.run(id, window, name, value);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { current_start, previous_start };
}
