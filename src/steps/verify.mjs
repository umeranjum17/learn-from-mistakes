// The verify step: the judge (judge_agent, an agent and model that differ from the worker's) tries to refute each finding
// of the analyse step and each fix of the propose step. The worker's claims are not evidence: the judge checks each claim
// against the bundle items it cites and answers confirmed, weakened or refuted, with a reason (`verdict` and `judge_note`
// in the findings and proposals tables). The answer's shape and its reasons (STE100) are checked and a bad answer is sent
// back once; on the second answer only the verdicts that break a rule are dropped (logged), and a claim with no verdict
// stays unjudged (NULL). The step logs ids and verdicts only, never the judge's text. With no claim it asks no agent.
import { readFileSync } from 'node:fs';
import { plain } from '../check.mjs';
import { agentStep } from './agent-step.mjs';

const PROMPT = readFileSync(new URL('../prompts/verify.md', import.meta.url), 'utf8');
const VERDICTS = ['confirmed', 'weakened', 'refuted'];

function verdictProblems(v, i, claims) {
  const at = `verdicts[${i}]`;
  if (!v || typeof v !== 'object') return [`${at} must be an object`];
  const p = [];
  if (!claims.has(v.item)) p.push(`${at}.item must be the id of a claim to judge`);
  if (!VERDICTS.includes(v.verdict)) p.push(`${at}.verdict must be confirmed, weakened or refuted`);
  p.push(plain(v.reason, `${at}.reason`, { words: 25 }));
  return p.filter(Boolean);
}

// Keeps the verdicts that follow the rules, one per claim; `bad` names each one that does not, with its problem.
function sift(v, claims) {
  const bad = [], given = new Set();
  const verdicts = v.verdicts.filter((x, i) => {
    const p = verdictProblems(x, i, claims);
    if (!p.length && given.has(x.item)) p.push(`verdicts[${i}] is a second verdict for ${x.item}`);
    bad.push(...p);
    if (p.length) return false;
    given.add(x.item);
    return true;
  });
  return { verdicts, bad };
}

// The first answer must judge every claim by the rules; on the second only a verdicts value that is not a list fails the step.
function check(v, claims, attempt) {
  if (!Array.isArray(v.verdicts)) return ['verdicts must be a list'];
  if (attempt > 1) return [];
  const { verdicts, bad } = sift(v, claims);
  for (const k of claims.keys()) if (!verdicts.some((x) => x.item === k)) bad.push(`verdicts has no verdict for ${k}`);
  return bad;
}

export async function verify(cfg, db, id, dir, log) {
  for (const t of ['findings', 'proposals']) db.prepare(`UPDATE ${t} SET verdict = NULL, judge_note = NULL WHERE run_id = ?`).run(id); // a step run again starts empty
  const refs = (r) => JSON.parse(r).join(', ');
  // Claim ids: f<n> for the run's findings and p<n> for its fixes, each in table order.
  const claims = new Map([
    ...db.prepare('SELECT id, cause, summary, refs_json FROM findings WHERE run_id = ? ORDER BY id').all(id)
      .map((f, i) => [`f${i + 1}`, { table: 'findings', id: f.id, text: `finding for cause ${f.cause}. ${f.summary} Refs: ${refs(f.refs_json)}.` }]),
    ...db.prepare('SELECT id, cause, target, owner, change, metric, tripwire, refs_json FROM proposals WHERE run_id = ? ORDER BY id').all(id)
      .map((f, i) => [`p${i + 1}`, { table: 'proposals', id: f.id, text: `fix for cause ${f.cause}. Target: ${f.target}. Owner: ${f.owner}. Change: ${f.change} `
        + `Metric: ${f.metric ?? `cause_count:${f.cause}`}. Tripwire: ${f.tripwire ?? 'none'}. Refs: ${refs(f.refs_json)}.` }]),
  ]);
  const none = { asked: false, confirmed: 0, weakened: 0, refuted: 0, unjudged: 0 };
  if (!claims.size) {
    log('nothing to verify: no finding and no fix');
    return none;
  }
  const items = [...claims].map(([k, c]) => `- ${k}: ${c.text}`).join('\n');
  const answer = await agentStep(cfg, db, id, dir, { step: 'verify', role: 'judge', prompt: PROMPT.replace('{{items}}', () => items), check: (x, attempt) => check(x, claims, attempt), log });
  const { verdicts, bad } = sift(answer, claims);
  if (bad.length) log(`dropped: ${bad.join('; ')}`);
  db.exec('BEGIN');
  try {
    for (const v of verdicts) {
      const c = claims.get(v.item);
      db.prepare(`UPDATE ${c.table} SET verdict = ?, judge_note = ? WHERE id = ?`).run(v.verdict, v.reason.trim(), c.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const out = { ...none, asked: true, unjudged: claims.size - verdicts.length };
  for (const v of verdicts) {
    out[v.verdict]++;
    if (v.verdict !== 'confirmed') log(`${v.verdict}: ${v.item}`);
  }
  log(`verdicts: ${out.confirmed} confirmed, ${out.weakened} weakened, ${out.refuted} refuted, ${out.unjudged} not judged`);
  return out;
}
