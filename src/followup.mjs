// The followup step: did each applied change work? For every change in the ledger it computes the change's metric
// from the events and records collect saved: `before` over the window's length up to the change, `after` from the
// change to the end of the run. The verdict is set by code, by the first rule that fits:
//   no-data   the after range has fewer than followup.min_sessions sessions or followup.min_days days, the metric is
//             n/a before or after it (nothing measures it), or a records-based metric's source has no record on or
//             before the start of the before window (it does not cover that window)
//   keep      the tripwire is met
//   delete    a rule change whose metric moved less than 10% of before (or stayed 0) in this retro and the last
//   no-data   the change has no tripwire, so there is nothing to check
//   rollback  the tripwire missed and the metric did not improve, or the tripwire missed in the last retro too
//   fix       the metric improved but the tripwire missed
// "The last retro" is this change's row in the latest earlier run that measured it (a run that failed or was cancelled
// before its followup step has none). When that row fails the first no-data rule, counted again over that run's after
// range with this run's events, there is no last retro.
import { join } from 'node:path';
import { measure, readLedger } from '../bin/learn-from-mistakes-axi.mjs';
import { RULE, SOURCES } from './config.mjs';
import { inWindow, meets, rounded, rowsOf, values } from './metrics.mjs';

const DAY = 86_400_000;
// When collect read: the current window runs from current_start for one window length.
const readAt = ({ current_start, previous_start }) => 2 * Date.parse(current_start) - Date.parse(previous_start);
// Better for the tripwire's direction: lower for < and <=, higher for > and >=, nearer the number for =.
function improved({ before, after, tripwire }) {
  const [, op, n] = RULE.exec(tripwire);
  return op[0] === '<' ? after < before : op[0] === '>' ? after > before : Math.abs(after - n) < Math.abs(before - n);
}
const flat = ({ before, after }) => (before === 0 ? after === 0 : Math.abs(after - before) < 0.1 * Math.abs(before));
const missed = (r) => r?.tripwire && meets(r.after, r.tripwire) === 0;

// `row` and `last` (undefined when there is no last retro) carry `enough`: the first no-data rule passed.
function verdict(row, kind, last) {
  if (!row.enough) return 'no-data';
  if (row.tripwire && !missed(row)) return 'keep';
  if (kind === 'rule' && flat(row) && last && flat(last)) return 'delete';
  if (!row.tripwire) return 'no-data';
  return improved(row) && !missed(last) ? 'fix' : 'rollback';
}

// The records a records-based metric reads, as a predicate on a record (null for a metric that reads events): a
// cause_count reads its match rule's source when that source keeps records, a source type's metric the records of its sources.
function recordsOf(cfg, metric) {
  if (metric.startsWith('cause_count:')) {
    const source = cfg.causes[metric.slice(12)]?.match?.source;
    return source && SOURCES[cfg.sources[source].type].metricRows !== 'events' ? (r) => r.source === source : null;
  }
  const type = Object.keys(SOURCES).find((t) => SOURCES[t].metricRows !== 'events' && SOURCES[t].metricNames?.includes(metric));
  return type ? (r) => cfg.sources[r.source]?.type === type : null;
}

// Saves one followups row per applied change, with the unrounded numbers; it can run again: it first drops the run's rows.
export function followup(cfg, db, id, window, log) {
  const w = Date.parse(window.current_start) - Date.parse(window.previous_start), end = readAt(window);
  const { events, records } = rowsOf(db, id);
  const { min_sessions, min_days } = cfg.followup;
  const last = db.prepare(`SELECT f.before, f.after, f.tripwire, s.output_json FROM followups f JOIN steps s ON s.run_id = f.run_id AND s.name = 'collect'
    WHERE f.change_id = ? AND f.run_id < ? ORDER BY f.run_id DESC LIMIT 1`);
  const add = db.prepare('INSERT INTO followups (run_id, change_id, metric, before, after, tripwire, verdict) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const rows = readLedger(join(cfg.state, 'changes.jsonl')).entries.map((c) => { // a bad ledger line is skipped: it gets no row
    const { metric, tripwire, kind } = measure(c), at = Date.parse(c.at);
    const value = (range) => values(cfg, events, records, range)[metric] ?? null; // a cause no longer in the config is n/a
    const of = recordsOf(cfg, metric);
    // A records-based metric's before is n/a unless its source has a record on or before the window's start.
    const before = of && !records.some((r) => of(r) && Date.parse(r.ts) <= at - w) ? null : value({ start: at - w, end: at });
    // The first no-data rule over the after range up to `upTo` (this run's has no end, as the current window).
    const enough = (r, readTime, upTo) => r.before !== null && r.after !== null && (readTime - at) / DAY >= min_days
      && new Set(inWindow(events, { start: at, end: upTo }).map((e) => e.session_id)).size >= min_sessions;
    const row = { change_id: c.id, metric, before, after: value({ start: at }), tripwire: tripwire || null };
    row.enough = enough(row, end, Infinity);
    const prev = last.get(c.id, id), prevEnd = prev && readAt(JSON.parse(prev.output_json));
    return { ...row, verdict: verdict(row, kind, prev && enough(prev, prevEnd, prevEnd) ? prev : undefined) };
  });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM followups WHERE run_id = ?').run(id);
    for (const r of rows) add.run(id, r.change_id, r.metric, r.before, r.after, r.tripwire, r.verdict);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const r of rows) log(`${r.change_id} ${r.metric}: ${rounded(r.before)} before, ${rounded(r.after)} after, ${r.verdict}`);
  return { changes: rows.length };
}
