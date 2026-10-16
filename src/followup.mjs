// The followup step: did each applied change work? For every change in the ledger it computes the change's metric
// from the events and records collect saved: `before` over the window's length up to the change, `after` from the
// change to the end of the run. The change is measured from when its fix went live: an apply-recorded fix from when
// its branch reached the default branch (features/followup.md), a hand-recorded change from its recorded time.
// A fix whose branch has not reached the default branch is not live yet: n/a numbers, no-data, and a plain reason.
// The verdict is set by code, by the first rule that fits:
//   no-data   the after range has fewer than followup.min_days days, or fewer than followup.min_sessions sessions and,
//             for a records-based metric, fewer than that many of the records it reads, the metric is
//             n/a before or after it (nothing measures it), or a records-based metric's source has no record on or
//             before the start of the before window (it does not cover that window), or collect's read started after the
//             before window's start, or after the change (a change added after collect with an older `at`: n/a)
//   keep      the tripwire is met
//   delete    a rule change whose metric moved less than 10% of before (or stayed 0) in this retro and the last
//   no-data   the change has no tripwire, so there is nothing to check
//   rollback  the tripwire missed and the metric did not improve, or the tripwire missed in the last retro too
//   fix       the metric improved but the tripwire missed
// "The last retro" is this change's row in the latest earlier run that measured it whose read time is at least
// followup.min_days before this run's, so a rerun over the same data is not a second retro (a run that failed or was
// cancelled before its followup step has none). When that row fails the first no-data rule, counted again over that
// run's after range with this run's events, there is no last retro.
import { join } from 'node:path';
import { measure, readLedger } from '../bin/learn-from-mistakes-axi.mjs';
import { RULE, SOURCES } from './config.mjs';
import { liveAt } from './merge-time.mjs';
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
// cause_count reads its match rule's source when that source keeps records, a source type's metric the records of the sources that give or add to it.
function recordsOf(cfg, metric) {
  if (metric.startsWith('cause_count:')) {
    const source = cfg.causes[metric.slice(12)]?.match?.source;
    return source && SOURCES[cfg.sources[source].type].metricRows !== 'events' ? (r) => r.source === source : null;
  }
  const types = Object.keys(SOURCES).filter((t) => SOURCES[t].metricRows !== 'events' && [...(SOURCES[t].metricNames ?? []), ...(SOURCES[t].addsTo ?? [])].includes(metric.split(':')[0]));
  return types.length ? (r) => types.includes(cfg.sources[r.source]?.type) : null;
}

// Saves one followups row per applied change, with the unrounded numbers; it can run again: it first drops the run's rows.
export function followup(cfg, db, id, window, log) {
  const w = Date.parse(window.current_start) - Date.parse(window.previous_start), end = readAt(window), from = Date.parse(window.read_from);
  const { events, records } = rowsOf(db, id);
  const { min_sessions, min_days } = cfg.followup;
  const last = db.prepare(`SELECT f.before, f.after, f.tripwire, s.output_json FROM followups f JOIN steps s ON s.run_id = f.run_id AND s.name = 'collect'
    WHERE f.change_id = ? AND f.run_id < ? ORDER BY f.run_id DESC`);
  const add = db.prepare('INSERT INTO followups (run_id, change_id, metric, before, after, tripwire, verdict, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const rows = readLedger(join(cfg.state, 'changes.jsonl')).entries.map((c) => { // a bad ledger line is skipped: it gets no row
    const { metric, tripwire, kind } = measure(c), live = liveAt(cfg.dir, c), at = live.live ? live.at : Date.parse(c.at);
    // A fix whose branch has not reached the default branch is not live yet: no
    // numbers, no verdict but no-data, and the plain reason instead.
    if (!live.live) return { change_id: c.id, metric, before: null, after: null, tripwire: tripwire || null, enough: false, verdict: 'no-data', reason: live.reason };
    const value = (range) => values(cfg, events, records, range)[metric] ?? null; // a cause no longer in the config is n/a
    const of = recordsOf(cfg, metric);
    const covered = (ms) => from <= ms;
    // A records-based metric's before is n/a unless its source has a record on or before the window's start.
    const before = !covered(at - w) || (of && !records.some((r) => of(r) && Date.parse(r.ts) <= at - w)) ? null : value({ start: at - w, end: at });
    // The first no-data rule over the after range up to `upTo` (this run's has no end, as the current window). A
    // records-based metric's own records count too, so a project with no sessions source can pass it.
    const enough = (r, readTime, upTo) => {
      const range = { start: at, end: upTo };
      return r.before !== null && r.after !== null && (readTime - at) / DAY >= min_days
        && (new Set(inWindow(events, range).map((e) => e.session_id)).size >= min_sessions || (of && inWindow(records.filter(of), range).length >= min_sessions));
    };
    const row = { change_id: c.id, metric, before, after: covered(at) ? value({ start: at }) : null, tripwire: tripwire || null, reason: null };
    row.enough = enough(row, end, Infinity);
    const prev = last.all(c.id, id).map((p) => ({ ...p, readTime: readAt(JSON.parse(p.output_json)) }))
      .find((p) => end - p.readTime >= min_days * DAY);
    return { ...row, verdict: verdict(row, kind, prev && enough(prev, prev.readTime, prev.readTime) ? prev : undefined) };
  });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM followups WHERE run_id = ?').run(id);
    for (const r of rows) add.run(id, r.change_id, r.metric, r.before, r.after, r.tripwire, r.verdict, r.reason);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const r of rows) log(`${r.change_id} ${r.metric}: ${rounded(r.before)} before, ${rounded(r.after)} after, ${r.verdict}${r.reason ? `: ${r.reason}` : ''}`);
  return { changes: rows.length };
}
