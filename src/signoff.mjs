// Explicit, optional contract-v1 handoff. Freeze the first message so retrying a run keeps the same key and bytes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { appliedFixes, appliedLine } from './apply.mjs';
import { clusters } from './bundle.mjs';
import { counts } from './check.mjs';
import { redact } from './redact.mjs';
import { which } from './runners/index.mjs';
import { locked, openStore } from './store.mjs';

const HELP = 'sign-off-axi --help   # read the refusal help; never edit the board file';
const AGAIN = 'learn-from-mistakes-axi retro --wait 15m   # rerun retro to produce valid findings';
const TEST_BOARD = 'set HOME, SIGN_OFF_HOME and LFM_TEST_BOARD_ROOT to a mktemp directory before posting in tests or demos';
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
const under = (parent, child) => {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
// Tests and demos set LFM_TEST_MODE or LFM_DEMO_MODE. Refuse any post whose resolved board is not under the throwaway root.
export function refuseRealBoard() {
  if (!process.env.LFM_TEST_MODE && !process.env.LFM_DEMO_MODE) return;
  const root = resolve(process.env.LFM_TEST_BOARD_ROOT || process.env.TMPDIR || tmpdir());
  const board = process.env.SIGN_OFF_HOME
    ? resolve(process.env.SIGN_OFF_HOME)
    : resolve(process.env.HOME || homedir(), '.sign-off');
  if (under(root, board)) return;
  const e = new UsageError(`test/demo mode refuses to post: board path ${board} is not under the temp board root ${root}`, TEST_BOARD);
  e.code = 2;
  throw e;
}
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
    : db.prepare("SELECT id, status FROM runs WHERE status = 'completed' AND kind IS NULL ORDER BY id DESC LIMIT 1").get(); // a retro, never an incident run
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

// Plain text for a report field: redacted, one line, cut at max characters.
const clip = (text, max) => {
  const t = redact(text ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim(), chars = [...t];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : t;
};
// The peer takes these seven report purposes and a project of up to 40 characters; a retro is an audit of the project it ran in.
export const PURPOSES = ['research', 'plan', 'decision', 'audit', 'incident', 'status', 'other'];
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The run's whole result as one sign-off report (contract 1, kind report, schema 3): the repeated mistakes, the kept fixes and what was
// not checked. It carries no options: Apply or Skip stays on the finding cards of `signoff post`. The key and every field come from the
// saved run, so a retry sends the same bytes and the board keeps one card.
function reportMessage(cfg, db, runId, opts = {}) {
  const run = db.prepare('SELECT updated_at FROM runs WHERE id = ?').get(runId);
  const window = JSON.parse(db.prepare("SELECT output_json FROM steps WHERE run_id = ? AND name = 'collect'").get(runId).output_json);
  const repeated = [...counts(cfg, db, runId, window).causes].filter(([, c]) => c.repeated);
  const findings = db.prepare("SELECT cause, summary FROM findings WHERE run_id = ? AND verdict IS NOT 'refuted' ORDER BY id").all(runId);
  const fixes = db.prepare('SELECT n, cause, change, verdict FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n').all(runId);
  const applied = appliedFixes(db, runId);
  const open = fixes.filter((f) => !applied.has(f.n)).length;
  // The "Not checked" lines of report.txt, already plain and redacted; the evidence lines under them stay in the file.
  const text = readFileSync(join(cfg.state, 'runs', String(runId), 'report.txt'), 'utf8');
  const gaps = (/^6\. Not checked\n([\s\S]*?)\n\n7\. /m.exec(text)?.[1] ?? '').split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- Nothing.'));
  return {
    contract: 1, kind: 'report', schema: 3, key: `lfm-report-${runId}`, filer: 'learn-from-mistakes',
    purpose: opts.purpose ?? 'audit', project: clip(opts.project ?? cfg.name, 40),
    title: clip(`Retro for ${cfg.name}: ${plural(repeated.length, 'repeated mistake')}, ${plural(fixes.length, 'fix', 'fixes')} kept`, 160),
    about: `Run ${runId}, window ${cfg.window}. Apply or Skip questions for the open fixes are separate cards: run learn-from-mistakes-axi signoff post.`,
    filed: `${new Date(run.updated_at).toISOString().slice(0, 19)}Z`,
    understood: [{ label: 'You asked', text: 'What do my coding agents keep getting wrong in this project?' }, { label: 'Window', text: `The last ${cfg.window}, against the window before it.` }],
    visual: { type: 'tiles', heading: repeated.length ? plural(repeated.length, 'mistake') + ' came back' : 'No mistake came back', rows: [
      { label: 'Repeated mistakes', text: String(repeated.length), tone: repeated.length ? 'bad' : 'ok' },
      { label: 'Fixes kept', text: `${fixes.length}, ${open} still open`, tone: open ? 'warn' : 'ok' },
      { label: 'Not checked', text: plural(gaps.length, 'gap'), tone: gaps.length ? 'warn' : 'ok' }] },
    sections: [
      { id: 'mistakes', stage: 'found', heading: 'Repeated mistakes', body: repeated.length ? `${plural(repeated.length, 'mistake')} came back in this window.` : 'No mistake came back in this window.',
        ...(repeated.length && { items: repeated.slice(0, 8).map(([cause, c]) => ({ title: clip(cause, 80), text: `${plural(c.count, 'time')} on ${plural(c.days, 'day')}.`,
          ...(findings.find((f) => f.cause === cause) && { more: clip(findings.find((f) => f.cause === cause).summary, 600) }) })) }) },
      { id: 'fixes', stage: 'recommend', heading: 'Fixes kept', body: fixes.length ? `${plural(fixes.length, 'fix', 'fixes')} passed the rules; ${applied.size} applied by the run.` : 'No fix passed the rules.',
        ...(fixes.length && { items: fixes.slice(0, 8).map((f) => ({ title: clip(`Fix ${f.n}, for ${f.cause}`, 80),
          text: `The judge: ${f.verdict ?? 'not judged'}. ${applied.has(f.n) ? 'Applied by the run.' : 'Not applied.'}`, more: clip(f.change, 600) })) }) },
      { id: 'not-checked', stage: 'found', heading: 'Not checked', body: gaps.length ? `${plural(gaps.length, 'gap')}. The full list is in report.txt.` : 'Nothing. The run read all sources and checked all items.',
        ...(gaps.length && { items: gaps.slice(0, 8).map((g, i) => ({ title: `Gap ${i + 1}`, text: clip(g.slice(2), 160) })) }) }],
    next: { heading: open ? 'Answer the open fixes on their own cards' : 'Nothing needs you', lines: ['The full text is in report.txt in the run folder.'] },
  };
}

// Posts the run's report to sign-off and saves the outcome (posted, skipped or failed) for `status`. It never throws: a run's
// report that sign-off cannot take must not fail the run. The same key and bytes go out on every retry, so the board keeps one card.
export async function postReport(cfg, db, runId, opts = {}) {
  const key = `lfm-report-${runId}`, bin = which('sign-off-axi');
  let state = 'posted', why = null;
  if (!bin) [state, why] = ['skipped', 'sign-off-axi is not installed; the report stays in report.txt (npm i -g sign-off-axi)'];
  else {
    try {
      refuseRealBoard();
      peer(bin, ['post', '--kind', 'report', '--from', '-'], cfg, JSON.stringify(reportMessage(cfg, db, runId, opts)));
    }
    catch (e) { [state, why] = ['failed', e.message]; }
  }
  db.prepare('INSERT INTO signoff_report (run_id, key, state, why) VALUES (?, ?, ?, ?) ON CONFLICT (run_id) DO UPDATE SET state = excluded.state, why = excluded.why')
    .run(runId, key, state, why);
  return { key, state, why };
}

export async function signoff(action, cfg, opts) {
  const db = await openStore(cfg.state, false);
  if (!db) throw new UsageError('no saved retro run', AGAIN);
  try {
    const bin = which('sign-off-axi');
    let reportHint = null;
    if (action === 'report') {
      const run = opts.run ? db.prepare('SELECT id, status FROM runs WHERE id = ?').get(Number(opts.run))
        : db.prepare("SELECT id, status FROM runs WHERE status = 'completed' AND kind IS NULL ORDER BY id DESC LIMIT 1").get(); // a retro, never an incident run
      if (run?.status !== 'completed') throw new UsageError('signoff report needs a completed run', AGAIN);
      const { key, state, why } = await postReport(cfg, db, run.id, opts);
      console.log(`${state}: ${key}${why ? ` (${why})` : ''}`);
      if (state === 'failed') process.exitCode = 1;
      return;
    }
    if (action === 'post') {
      const { runId, rows, done } = messages(cfg, db, opts); // validate every fix before sending any
      for (const line of done) console.log(line);
      if (bin && rows.length) refuseRealBoard();
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
