// Explicit, optional contract-v1 handoff. Freeze the first message so retrying a run keeps the same key and bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { appliedFixes, appliedLine } from './apply.mjs';
import { clusters } from './bundle.mjs';
import { counts } from './check.mjs';
import { redact } from './redact.mjs';
import { which } from './runners/index.mjs';
import { locked, openStore } from './store.mjs';

const HELP = 'sign-off-axi --help   # read the refusal help; never edit the board file';
const AGAIN = 'learn-from-mistakes-axi retro --wait 15m   # rerun retro to produce valid findings';
// The peer minimum: 0.3.4 is the first sign-off-axi release that takes a finding (contract 1, kind finding, schema 1).
export const SIGNOFF_MIN = '0.3.4';
// Version order by number, part by part, so 0.3.10 reads as later than 0.3.4.
export const atLeast = (v, min = SIGNOFF_MIN) => {
  const a = v.split('.').map(Number), b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};
const keyId = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(s);
const WAIT = ['wait', '--filer', 'learn-from-mistakes', '--timeout', '1', '--json'];
function peer(bin, args, cfg, input, noAnswer = false) {
  const r = spawnSync(bin, args, { cwd: cfg.dir, input, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (r.status === 0) return r.stdout;
  if (noAnswer && r.status === 1 && /code: (TIMEOUT|NOT_FOUND)/.test(r.stdout ?? '')) return null;
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const e = new UsageError(`sign-off-axi: ${r.error?.message ?? `exit ${r.status ?? r.signal}`}`, HELP);
  e.code = r.status === 2 ? 2 : 1;
  throw e;
}

// The run's kept fixes as sign-off messages, and the applied lines of the fixes its apply step applied: those are never asked.
function messages(cfg, db, opts) {
  const run = opts.run ? db.prepare('SELECT id, status FROM runs WHERE id = ?').get(Number(opts.run))
    : db.prepare("SELECT id, status FROM runs WHERE status = 'completed' ORDER BY id DESC LIMIT 1").get();
  if (run?.status !== 'completed') throw new UsageError('signoff post needs a completed run', AGAIN);
  const applied = appliedFixes(db, run.id), done = [...applied.values()].map((a) => appliedLine(run.id, a));
  const fixes = db.prepare('SELECT * FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n').all(run.id).filter((f) => !applied.has(f.n));
  if (!fixes.length) return { runId: run.id, rows: [], done };
  const window = JSON.parse(db.prepare("SELECT output_json FROM steps WHERE run_id = ? AND name = 'collect'").get(run.id).output_json);
  const { causes } = counts(cfg, db, run.id, window);
  const recordIds = new Map(db.prepare('SELECT id, record_id FROM records WHERE run_id = ?').all(run.id)
    .map((r) => [r.record_id, keyId(r.record_id) ? r.record_id : `rec-${r.id}`]));
  const eventIds = new Set(db.prepare('SELECT id FROM events WHERE run_id = ?').all(run.id).map((e) => `e${e.id}`));
  const groups = clusters(db, run.id, Date.parse(window.current_start));
  const rows = fixes.map((f) => {
    if (!['doc', 'rule', 'code'].includes(f.kind) || !/^[a-z0-9-]{1,64}$/.test(f.cause)) throw new UsageError(`proposal ${run.id}:${f.n}: missing or invalid kind or cause`, AGAIN);
    const saved = db.prepare('SELECT message FROM signoff WHERE proposal_id = ?').get(f.id);
    if (saved) return { id: f.id, message: JSON.parse(saved.message) };
    const proposal = redact(f.change);
    if (!proposal.trim() || [...proposal].length > 500 || /[\p{Cc}\p{Cf}]/u.test(proposal.replaceAll('\n', ''))) throw new UsageError(`proposal ${run.id}:${f.n}: change must be 1-500 characters with no control characters except newline`, AGAIN);
    const refs = JSON.parse(f.refs_json).flatMap((ref) => /^c\d+$/.test(ref) ? (groups[Number(ref.slice(1)) - 1]?.[1] ?? []).map((e) => `e${e.id}`) : [ref]);
    const ids = refs.map((ref) => recordIds.get(ref) ?? (eventIds.has(ref) ? ref : undefined));
    if (ids.some((ref) => !ref)) throw new UsageError(`proposal ${run.id}:${f.n}: evidence does not name records`, AGAIN);
    if (!causes.has(f.cause)) throw new UsageError(`proposal ${run.id}:${f.n}: cause ${f.cause} is no longer configured`, AGAIN);
    const c = causes.get(f.cause);
    const body = { contract: 1, kind: 'finding', schema: 1,
      title: `Repeated cause: ${f.cause}`, filer: 'learn-from-mistakes', about: `${c.count} incidents over ${c.days} days.`,
      cause: f.cause, incidents: c.count, days: c.days, evidence_ids: [...new Set(ids)].slice(0, 50), change_kind: f.kind,
      proposal, options: [{ value: 'apply', label: 'Apply' }, { value: 'skip', label: 'Skip' }], recommend_value: 'apply' };
    const key = `lfm-${run.id}-${f.n}-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 8)}`;
    return { id: f.id, message: { ...body, key } };
  });
  return { runId: run.id, rows, done };
}

export async function signoff(action, cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (!db) throw new UsageError('no saved retro run', AGAIN);
  try {
    const bin = which('sign-off-axi');
    let reportHint = null;
    if (action === 'post') {
      const { runId, rows, done } = messages(cfg, db, opts); // validate every fix before sending any
      for (const line of done) console.log(line);
      for (const { id, message: m } of rows) {
        if (bin) {
          peer(bin, ['post', '--kind', 'finding', '--from', '-'], cfg, JSON.stringify(m));
          db.prepare('INSERT OR IGNORE INTO signoff (proposal_id, message) VALUES (?, ?)').run(id, JSON.stringify(m)); // freeze only what the board accepted
          console.log(`posted: ${m.key}`);
        } else console.log(`kept: ${m.key}`);
      }
      if (!rows.length && !done.length) console.log('No kept fixes.');
      else if (!bin) reportHint = join(cfg.state, 'runs', String(runId), 'report.txt');
    } else if (bin) {
      const updates = locked(db, () => {
        let answers = {};
        const out = peer(bin, WAIT, cfg, undefined, true);
        if (out !== null) {
          try { answers = JSON.parse(out); }
          catch { throw new UsageError('sign-off-axi wait: invalid JSON', HELP); }
          if (!answers || Array.isArray(answers) || typeof answers !== 'object') throw new UsageError('sign-off-axi wait: expected a map by key', HELP);
        }
        const rows = db.prepare('SELECT s.proposal_id, s.message, p.n FROM signoff s JOIN proposals p ON p.id = s.proposal_id').all().flatMap((r) => {
          const key = JSON.parse(r.message).key, a = answers[key];
          if (!a) return [];
          if (r.n === null) { console.error(`sign-off-axi wait: ${key} is for a fix that is no longer kept; skipped`); return []; }
          if (!['apply', 'skip'].includes(a.answer)) { console.error(`sign-off-axi wait: ${key} answer is not apply or skip; skipped`); return []; }
          return [{ id: r.proposal_id, key, answer: a.answer }];
        });
        for (const r of rows) db.prepare('UPDATE signoff SET answer = ? WHERE proposal_id = ?').run(r.answer, r.id);
        return rows;
      });
      for (const r of updates) console.log(`saved: ${r.key} ${r.answer}`);
      if (!updates.length) console.log('No new answers for posted findings.');
    } else console.log('No answers read: sign-off-axi is not installed.');
    if (!bin) console.log('npm i -g sign-off-axi');
    if (reportHint) console.log(`fix text is in report.txt: ${reportHint}`);
  } finally { db.close(); }
}
