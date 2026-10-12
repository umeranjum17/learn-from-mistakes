// The metrics step: the numbers for this window (current) and the last (previous), from the events and records
// collect saved for the run. Each source type gives its numbers (its metrics(rows, window), over the rows of all its
// sources); cause_count:<cause> counts the items collect tagged with that cause. A metric whose source type is not
// configured is n/a (NULL), never 0. A metric with a target saves the target with its value.
import { RULE, SOURCES } from './config.mjs';

// The rows whose time is in the window: from its start, and before its end when it has one.
export const inWindow = (rows, { start, end = Infinity }) => rows.filter((r) => { const t = Date.parse(r.ts); return t >= start && t < end; });

// Whether a value meets a rule ("<op> <number>", a target or a tripwire): 1 met, 0 missed, null (n/a) when the value is n/a.
export function meets(value, rule) {
  if (value === null) return null;
  const [, op, n] = RULE.exec(rule), t = Number(n);
  return Number({ '>=': value >= t, '<=': value <= t, '>': value > t, '<': value < t, '=': value === t }[op]);
}

// The current window has no end, so an event the clock puts a little after the read still counts.
export function metrics(cfg, db, id, { current_start, previous_start }) {
  const windows = { current: { start: Date.parse(current_start) }, previous: { start: Date.parse(previous_start), end: Date.parse(current_start) } };
  const events = db.prepare('SELECT session_id, ts, kind, tool, signal, cause FROM events WHERE run_id = ?').all(id);
  const records = db.prepare('SELECT source, ts, cause FROM records WHERE run_id = ?').all(id);
  const add = db.prepare('INSERT INTO metrics (run_id, window, name, value, target) VALUES (?, ?, ?, ?, ?)');
  const types = new Set(Object.values(cfg.sources).map((s) => s.type));
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM metrics WHERE run_id = ?').run(id);
    for (const [window, w] of Object.entries(windows)) {
      const v = {};
      for (const [type, src] of Object.entries(SOURCES)) {
        if (!src.metricNames) continue;
        if (!types.has(type)) for (const name of src.metricNames) v[name] = null;
        else Object.assign(v, src.metrics(src.metricRows === 'events' ? events : records.filter((r) => cfg.sources[r.source]?.type === type), w));
      }
      for (const [cause, c] of Object.entries(cfg.causes)) {
        // n/a with no match rule, or when the rule's sessions source has no session in the window (as its other counts)
        const read = c.match && (SOURCES[cfg.sources[c.match.source].type].metricRows !== 'events' || inWindow(events, w).length);
        v[`cause_count:${cause}`] = read ? inWindow([...events, ...records].filter((r) => r.cause === cause), w).length : null;
      }
      for (const name of Object.keys(cfg.targets)) v[name] ??= null; // a target no source measures
      for (const [name, value] of Object.entries(v)) {
        const target = cfg.targets[name] ?? null;
        add.run(id, window, name, value, target);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { current_start, previous_start };
}
