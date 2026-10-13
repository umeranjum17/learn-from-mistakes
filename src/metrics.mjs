// The metrics step: the numbers for this window (current) and the last (previous), from the events and records
// collect saved for the run. Each source type gives its numbers (its metrics(rows, window), over the rows of all its
// sources); cause_count:<cause> counts the items collect tagged with that cause. A metric whose source type is not
// configured is n/a (NULL), never 0. A metric with a target saves the target with its value.
import { RULE, SOURCES } from './config.mjs';

// The rows whose time is in the window: from its start, and before its end when it has one.
export const inWindow = (rows, { start, end = Infinity }) => rows.filter((r) => { const t = Date.parse(r.ts); return t >= start && t < end; });

// A number as printed: rounded to 3 decimals, n/a for null. Stored numbers and verdicts stay unrounded.
export const rounded = (v) => (v === null ? 'n/a' : Math.round(v * 1000) / 1000);

// Whether a value meets a rule ("<op> <number>", a target or a tripwire): 1 met, 0 missed, null (n/a) when the value is n/a.
export function meets(value, rule) {
  if (value === null) return null;
  const [, op, n] = RULE.exec(rule), t = Number(n);
  return Number({ '>=': value >= t, '<=': value <= t, '>': value > t, '<': value < t, '=': value === t }[op]);
}

// Each metric's value over the events and records in one window; null (n/a) where nothing measures it.
export function values(cfg, events, records, w) {
  const types = new Set(Object.values(cfg.sources).map((s) => s.type));
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
  return v;
}

// The rows collect saved for the run, as the metrics read them.
export const rowsOf = (db, id) => ({
  events: db.prepare('SELECT session_id, ts, kind, tool, signal, cause FROM events WHERE run_id = ?').all(id),
  records: db.prepare('SELECT source, ts, cause, data FROM records WHERE run_id = ?').all(id),
});

// The current window has no end, so an event the clock puts a little after the read still counts.
export function metrics(cfg, db, id, { current_start, previous_start }) {
  const windows = { current: { start: Date.parse(current_start) }, previous: { start: Date.parse(previous_start), end: Date.parse(current_start) } };
  const { events, records } = rowsOf(db, id);
  const add = db.prepare('INSERT INTO metrics (run_id, window, name, value, target) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM metrics WHERE run_id = ?').run(id);
    for (const [window, w] of Object.entries(windows)) {
      for (const [name, value] of Object.entries(values(cfg, events, records, w))) add.run(id, window, name, value, cfg.targets[name] ?? null);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { current_start, previous_start };
}
