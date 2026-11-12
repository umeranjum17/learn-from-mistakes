// `fixes`: the life of each fix, read from what the tool already keeps and written nowhere. One word per fix, the last
// move it made (FIX_MOVES in run-shape.mjs): proposed (a completed run kept it), kept (the user answered apply),
// applied (a change in the ledger records it), shipped (live on the default branch), worked (an incident fix's check
// passed, or the latest follow-up met the tripwire) or reverted (the default branch reverted it). It runs no check.
import { join } from 'node:path';
import { readLedger } from '../bin/learn-from-mistakes-axi.mjs';
import { liveAt, revertedFix } from './merge-time.mjs';
import { redact } from './redact.mjs';

const proposalOf = (c) => c.proposal ?? /^fix (\d+:\d+) on branch /.exec(c.what ?? '')?.[1]; // the kept fix a change came from

export function fixesList(cfg, db) {
  const { entries } = readLedger(join(cfg.state, 'changes.jsonl'));
  const changeOf = new Map(entries.flatMap((c) => (proposalOf(c) ? [[proposalOf(c), c]] : [])));
  const latest = db?.prepare('SELECT stages FROM followups WHERE change_id = ? ORDER BY run_id DESC LIMIT 1');
  const worked = (id) => { try { return JSON.parse(latest?.get(id)?.stages ?? '{}').worked === 'yes'; } catch { return false; } };
  const rows = db ? db.prepare(`SELECT p.run_id, p.n, p.cause, p.kind, p.priority, p.owner, p.passed_at, s.answer FROM proposals p
    JOIN runs r ON r.id = p.run_id LEFT JOIN signoff s ON s.proposal_id = p.id
    WHERE r.status = 'completed' AND p.n IS NOT NULL ORDER BY p.run_id, p.n`).all() : [];
  const state = (change, kept, passed) => {
    if (!change) return kept ? 'kept' : 'proposed';
    if (revertedFix(cfg.dir, change)) return 'reverted';
    if (!liveAt(cfg.dir, change).live) return 'applied';
    return passed || worked(change.id) ? 'worked' : 'shipped';
  };
  const fixes = rows.map((p) => {
    const change = changeOf.get(`${p.run_id}:${p.n}`);
    return { fix: `${p.run_id}:${p.n}`, cause: p.cause, state: state(change, p.answer === 'apply', p.passed_at), ...(p.priority && { priority: p.priority }), ...(p.owner && { owner: redact(p.owner) }), ...(change && { change: change.id }) };
  });
  const viaFix = new Set(changeOf.values()); // a change recorded by hand names no kept fix: it is its own row
  for (const c of entries.filter((e) => !viaFix.has(e))) fixes.push({ fix: c.id, cause: c.cause, state: state(c), change: c.id });
  return { count: fixes.length, fixes };
}
