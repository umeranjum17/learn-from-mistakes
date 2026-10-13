// The followup step: did each applied change work? For every change in the ledger it computes the change's metric
// from the events and records collect saved: `before` over the window's length up to the change, `after` from the
// change to the end of the run. The verdict is set by code, by the first rule that fits:
//   no-data   the after range has fewer than followup.min_sessions sessions or followup.min_days days,
//             or the metric is n/a before or after it (nothing measures it)
//   delete    a rule change whose metric moved less than 10% of before (or stayed 0) in this retro and the last
//   no-data   the change has no tripwire, so there is nothing to check
//   keep      the tripwire is met
//   rollback  the tripwire missed and the metric did not improve, or the tripwire missed in the last retro too
//   fix       the metric improved but the tripwire missed
// "The last retro" is this change's row in the latest earlier run; a no-data row there breaks the run of retros.
import { join } from 'node:path';
import { measure, readLedger } from '../bin/learn-from-mistakes-axi.mjs';
import { RULE } from './config.mjs';
import { inWindow, meets, rowsOf, values } from './metrics.mjs';

const DAY = 86_400_000;
// Better for the tripwire's direction: lower for < and <=, higher for > and >=, nearer the number for =.
function improved({ before, after, tripwire }) {
  const [, op, n] = RULE.exec(tripwire);
  return op[0] === '<' ? after < before : op[0] === '>' ? after > before : Math.abs(after - n) < Math.abs(before - n);
}
const flat = ({ before, after }) => (before === 0 ? after === 0 : Math.abs(after - before) < 0.1 * Math.abs(before));
const missed = (r) => r?.tripwire && meets(r.after, r.tripwire) === 0;

function verdict(row, kind, last, { min_sessions, min_days }, sessions, days) {
  if (sessions < min_sessions || days < min_days || row.before === null || row.after === null) return 'no-data';
  if (kind === 'rule' && flat(row) && last && flat(last)) return 'delete';
  if (!row.tripwire) return 'no-data';
  if (!missed(row)) return 'keep';
  return improved(row) && !missed(last) ? 'fix' : 'rollback';
}

// Saves one followups row per applied change, with the unrounded numbers; it can run again: it first drops the run's rows.
export function followup(cfg, db, id, { current_start, previous_start }, log) {
  const w = Date.parse(current_start) - Date.parse(previous_start), end = Date.parse(current_start) + w; // when collect read
  const { events, records } = rowsOf(db, id);
  const last = db.prepare('SELECT before, after, tripwire, verdict FROM followups WHERE change_id = ? AND run_id < ? ORDER BY run_id DESC LIMIT 1');
  const add = db.prepare('INSERT INTO followups (run_id, change_id, metric, before, after, tripwire, verdict) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const rows = readLedger(join(cfg.state, 'changes.jsonl')).entries.map((c) => { // a bad ledger line fails the report step
    const { metric, tripwire, kind } = measure(c), at = Date.parse(c.at), after = { start: at };
    const value = (range) => values(cfg, events, records, range)[metric] ?? null; // a cause no longer in the config is n/a
    const row = { change_id: c.id, metric, before: value({ start: at - w, end: at }), after: value(after), tripwire: tripwire || null };
    const sessions = new Set(inWindow(events, after).map((e) => e.session_id)).size;
    const prev = last.get(c.id, id);
    return { ...row, verdict: verdict(row, kind, prev?.verdict === 'no-data' ? undefined : prev, cfg.followup, sessions, (end - at) / DAY) };
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
  for (const r of rows) log(`${r.change_id} ${r.metric}: ${r.before ?? 'n/a'} before, ${r.after ?? 'n/a'} after, ${r.verdict}`);
  return { changes: rows.length };
}
