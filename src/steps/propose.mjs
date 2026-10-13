// The propose step: the worker reads each cause with how often it came back, the findings the analyse step kept and the
// follow-ups whose verdict is not keep, then the bundle. It proposes fixes (the `proposals` table, in its order), each with
// a cause, a target, an owner, the change, a metric, a tripwire and refs to bundle items, and gives the reason for each
// of those follow-ups (`followups.reason`); it never sets a verdict. The answer's shape and its free text (STE100) are
// checked and a bad answer is sent back once; on the second answer only the proposals and reasons that break a rule are
// dropped (logged), and the check step then keeps only the fixes that follow the rules.
// With no finding and no follow-up to explain it asks the worker nothing.
import { readFileSync } from 'node:fs';
import { METRIC_RULE } from '../config.mjs';
import { rounded } from '../metrics.mjs';
import { counts, plain } from '../check.mjs';
import { agentStep } from './agent-step.mjs';

const PROMPT = readFileSync(new URL('../prompts/propose.md', import.meta.url), 'utf8');
const str = (v) => typeof v === 'string';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function proposalProblems(f, i) {
  const at = `proposals[${i}]`;
  if (!f || typeof f !== 'object') return [`${at} must be an object`];
  const p = [];
  for (const k of ['cause', 'target', 'owner']) if (!str(f[k])) p.push(`${at}.${k} must be a string`);
  p.push(plain(f.change, `${at}.change`, { sentences: 3 }));
  for (const k of ['metric', 'tripwire']) if (f[k] != null && !str(f[k])) p.push(`${at}.${k} must be a string`);
  if (!Array.isArray(f.refs) || !f.refs.every(str)) p.push(`${at}.refs must be a list of bundle ids`);
  return p.filter(Boolean);
}

function reasonProblems(r, i, changes) {
  const at = `reasons[${i}]`;
  if (!r || typeof r !== 'object') return [`${at} must be an object`];
  const p = [];
  if (!changes.includes(r.change)) p.push(`${at}.change must be the id of a follow-up to explain`);
  p.push(plain(r.reason, `${at}.reason`, { words: 25 }));
  return p.filter(Boolean);
}

// Keeps the proposals and reasons that follow the rules; `bad` names each one that does not, with its problem.
function sift(v, changes) {
  const bad = [];
  const proposals = v.proposals.filter((f, i) => {
    const p = proposalProblems(f, i);
    bad.push(...p);
    return !p.length;
  });
  const given = new Set();
  const reasons = v.reasons.filter((r, i) => {
    const p = reasonProblems(r, i, changes);
    if (!p.length && given.has(r.change)) p.push(`reasons[${i}] is a second reason for ${r.change}`);
    bad.push(...p);
    if (p.length) return false;
    given.add(r.change);
    return true;
  });
  return { proposals, reasons, bad };
}

// The first answer must be fully valid; on the second only a list that is not a list fails the step.
function check(v, changes, attempt) {
  const p = [];
  if (!Array.isArray(v.proposals)) p.push('proposals must be a list');
  if (!Array.isArray(v.reasons)) p.push('reasons must be a list');
  if (p.length || attempt > 1) return p;
  const { reasons, bad } = sift(v, changes);
  for (const c of changes) if (!reasons.some((r) => r.change === c)) bad.push(`reasons has no reason for ${c}`);
  return bad;
}

export async function propose(cfg, db, id, dir, window, log) {
  db.prepare('DELETE FROM proposals WHERE run_id = ?').run(id); // a step run again starts empty
  db.prepare('UPDATE followups SET reason = NULL WHERE run_id = ?').run(id);
  const findings = db.prepare('SELECT cause, summary, refs_json FROM findings WHERE run_id = ? ORDER BY id').all(id);
  const followups = db.prepare(`SELECT change_id, metric, before, after, tripwire, verdict FROM followups WHERE run_id = ? AND verdict != 'keep' ORDER BY rowid`).all(id);
  if (!findings.length && !followups.length) {
    log('nothing to propose: no finding and no follow-up to explain');
    return { asked: false, fixes: 0, reasons: 0 };
  }
  const list = (lines) => (lines.length ? lines.join('\n') : 'None.');
  const fill = {
    metrics: METRIC_RULE,
    causes: list([...counts(cfg, db, id, window).causes].map(([c, n]) => `- ${c}: ${plural(n.count, 'incident')} on ${plural(n.days, 'day')}, ${n.repeated ? 'repeated' : 'did not repeat'}`)),
    findings: list(findings.map((f) => `- ${f.cause}: ${f.summary} Refs: ${JSON.parse(f.refs_json).join(', ')}.`)),
    followups: list(followups.map((f) => `- ${f.change_id}: metric ${f.metric}, ${rounded(f.before)} before, ${rounded(f.after)} after, tripwire ${f.tripwire ?? 'none'}, verdict ${f.verdict}`)),
  };
  const changes = followups.map((f) => f.change_id);
  const answer = await agentStep(cfg, db, id, dir, { step: 'propose', role: 'worker', prompt: PROMPT.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k]), check: (x, attempt) => check(x, changes, attempt), log });
  const { proposals, reasons, bad } = sift(answer, changes);
  if (bad.length) log(`dropped: ${bad.join('; ')}`);
  const add = db.prepare('INSERT INTO proposals (run_id, cause, target, owner, change, metric, tripwire, refs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const reason = db.prepare('UPDATE followups SET reason = ? WHERE run_id = ? AND change_id = ?');
  db.exec('BEGIN');
  try {
    for (const f of proposals) add.run(id, f.cause, f.target, f.owner, f.change.trim(), f.metric ?? null, f.tripwire ?? null, JSON.stringify(f.refs));
    for (const r of reasons) reason.run(r.reason.trim(), id, r.change);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  log(`fixes: ${proposals.length} proposed, reasons: ${reasons.length} of ${changes.length} follow-ups`);
  return { asked: true, fixes: proposals.length, reasons: reasons.length };
}
