// The run's report for a person: <run dir>/report.txt, plain text in the seven sections of the plan. Each line a person
// reads is STE100: sentences of at most 20 words in plain words and the active voice, with no record id, session id or path. Those go only on the
// `Evidence:` lines, as pointers a person can open: file:line, `session <id> at <time>`, `PR #N` or a gate store row, and on the `applied:`
// line of a fix the run's apply step applied: its branch, commit and ledger id.
// Text an agent or the config wrote is redacted and shown only when it keeps the plain-language rule.
import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { appliedFixes, appliedLine } from './apply.mjs';
import { clusters } from './bundle.mjs';
import { counts, plain } from './check.mjs';
import { redact } from './redact.mjs';
import { which } from './runners/index.mjs';

const EVIDENCE = 3; // pointers shown per item; the rest are counted
const DO = { keep: 'Keep it.', fix: 'Change it. The metric got better, but it missed the tripwire.', rollback: 'Roll it back.',
  delete: 'Delete it. It did not change the metric.', 'no-data': 'Wait for more data.' };
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
// A path, a file name, a bundle id (c3, e12), a hash or a session uuid: none goes on a line a person reads.
const RAW = /(?:^|[\s(])[~.]{0,2}\/\S|\w\/\w|\b[\w-]+\.(?:[cm]js|ts|md|json|ya?ml|sqlite|db|sh|py)\b|\b[ce]\d+\b|\b[0-9a-f]{12,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-/i;
// Free text from an agent or the config, on its own line; text that breaks the sentence rule or names a RAW item is left out.
const said = (text) => {
  const t = redact(text ?? '').replace(/\s+/g, ' ').trim();
  return t && !plain(t, '', {}) && !RAW.test(t) ? `  ${t}` : '  This text breaks the report rules, so the report hides it.';
};

// `run` is the run as `status` shows it before the report step: its metrics, follow-ups, fixes and sources.
export function reportText(cfg, db, id, dir, window, run) {
  const all = (sql, ...args) => db.prepare(sql).all(id, ...args);
  const records = new Map(all('SELECT record_id, source, ref FROM records WHERE run_id = ?').map((r) => [r.record_id, r]));
  const events = new Map(all('SELECT id, session_id, ts FROM events WHERE run_id = ?').map((e) => [`e${e.id}`, e]));
  const groups = clusters(db, id, Date.parse(window.current_start));
  const pointer = (ref) => {
    const e = events.get(ref), r = records.get(ref);
    if (e) return `session ${e.session_id} at ${e.ts}`;
    const row = /^db:(\w+):(.+)$/.exec(r?.ref ?? ''), file = (f) => (isAbsolute(f) && !relative(cfg.dir, f).startsWith('..') ? relative(cfg.dir, f) : f);
    return row ? `${file(cfg.sources[r.source]?.path ?? r.source)} ${row[1]} row ${row[2]}` : r && file(r.ref);
  };
  const evidence = (refs) => {
    const ps = [...new Set(refs.flatMap((ref) => /^c\d+$/.test(ref) ? (groups[ref.slice(1) - 1]?.[1] ?? []).map((e) => `e${e.id}`) : [ref]).map(pointer).filter(Boolean))];
    return `   Evidence: ${ps.slice(0, EVIDENCE).join('; ') || 'none'}${ps.length > EVIDENCE ? `; and ${ps.length - EVIDENCE} more` : ''}`;
  };
  const { causes } = counts(cfg, db, id, window);
  const findings = all(`SELECT cause, summary, refs_json, verdict FROM findings WHERE run_id = ? AND verdict IS NOT 'refuted' ORDER BY id`);
  const fixes = all('SELECT n, cause, owner, change, refs_json, verdict, judge_note FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n');
  const reasons = new Map(all('SELECT change_id, reason FROM followups WHERE run_id = ?').map((f) => [f.change_id, f.reason]));
  const applied = appliedFixes(db, id);
  const repeated = [...causes].filter(([, c]) => c.repeated);
  const missed = run.metrics.filter((m) => m.met === 'missed').length;
  const lines = ['Retro report', '', '1. Short answer',
    repeated.length ? `- ${plural(repeated.length, 'mistake')} came back in this window.` : '- No mistake came back in this window.',
    `- ${plural(fixes.length, 'fix', 'fixes')} passed the rules. The judge confirmed ${fixes.filter((f) => f.verdict === 'confirmed').length} of them.`,
    `- ${plural(missed, 'metric')} missed the target.`, '', '2. Numbers'];
  const measured = run.metrics.filter((m) => m.target || m.current !== 'n/a' || m.previous !== 'n/a'); // the rest have no data
  for (const m of measured) lines.push(`- ${m.name}: this window ${m.current}, last window ${m.previous}, ${m.target ? `target ${m.target}, ${m.met === 'n/a' ? 'no data' : m.met}` : 'no target'}.`);
  if (!measured.length) lines.push('- No metric has data.');
  lines.push('', '3. Last changes');
  for (const f of run.followups) {
    lines.push(`- Change ${f.change}, metric ${f.metric}: ${f.before} before, ${f.after} after. The verdict is ${f.verdict}. ${DO[f.verdict]}`);
    if (reasons.get(f.change)) lines.push(said(reasons.get(f.change)));
  }
  if (!run.followups.length) lines.push('- No applied change has a follow-up yet.');
  lines.push('', '4. Repeated mistakes');
  for (const [cause, c] of repeated) {
    const refs = [...all('SELECT record_id FROM labels WHERE run_id = ? AND cause = ? AND event = 1', cause).map((l) => l.record_id),
      ...all('SELECT record_id FROM records WHERE run_id = ? AND cause = ?', cause).map((r) => r.record_id),
      ...all('SELECT id FROM events WHERE run_id = ? AND cause = ?', cause).map((e) => `e${e.id}`),
      ...findings.filter((f) => f.cause === cause).flatMap((f) => JSON.parse(f.refs_json))];
    lines.push(`- ${cause}: ${plural(c.count, 'time')} on ${plural(c.days, 'day')}.`, evidence(refs));
  }
  if (!repeated.length) lines.push('- None.');
  lines.push('', '5. Fixes');
  for (const f of fixes) {
    const refs = JSON.parse(f.refs_json);
    const finding = findings.find((x) => x.cause === f.cause && JSON.parse(x.refs_json).some((r) => refs.includes(r))) ?? findings.find((x) => x.cause === f.cause);
    const shown = run.fixes.find((x) => x.n === f.n);
    const target = run.metrics.find((m) => m.name === shown.metric)?.target;
    lines.push(`Fix ${f.n}, for ${f.cause}:`, '- Finding:', said(finding?.summary ?? cfg.causes[f.cause]?.description), '- Owner:', said(f.owner), '- Change:', said(f.change),
      `- Metric: ${shown.metric}, ${target ? `target ${target}` : 'no target'}. Tripwire: ${shown.tripwire}.`, `- The judge's verdict: ${shown.verdict}.`);
    if (f.judge_note) lines.push(said(f.judge_note));
    lines.push(evidence(JSON.parse(f.refs_json)));
    if (applied.has(f.n)) lines.push(`   ${appliedLine(id, applied.get(f.n))}`);
  }
  if (!fixes.length) lines.push('- No fix passed the rules.');
  const step = (name) => JSON.parse(db.prepare('SELECT output_json FROM steps WHERE run_id = ? AND name = ?').get(id, name)?.output_json ?? '{}');
  const judged = (verdict) => [...fixes, ...findings].filter((x) => x.verdict === verdict).length; // the kept fixes and the findings counted above
  const gaps = [...run.sources.filter((s) => !s.items).map((s) => `- Source ${s.id} gave no records.`),
    ...run.sources.filter((s) => s.skipped).map((s) => `- Source ${s.id} skipped ${plural(s.skipped, 'session')}.`),
    ...[[step('bundle').dropped, 'The bundle was full. It left out'], [step('analyse').labels_dropped, 'The worker broke the rules on', 'label'],
      [all('SELECT count(*) AS n FROM proposals WHERE run_id = ? AND problem IS NOT NULL')[0].n, 'The rules left out', 'fix', 'fixes'],
      [judged('weakened'), 'The judge weakened'], [judged(null), 'The judge did not check']]
      .filter(([n]) => n).map(([n, what, word = 'item', many]) => `- ${what} ${plural(n, word, many)}.`)];
  lines.push('', '6. Not checked', ...(gaps.length ? gaps : ['- Nothing. The run read all sources and checked all items.']), '', '7. Questions for you');
  const open = fixes.filter((f) => !applied.has(f.n)); // a fix the run applied is never asked about
  const signoff = Boolean(cfg.signoff !== 'off' && which('sign-off-axi') && open.length); // sign-off asks Apply or Skip for each open fix
  const asks = [...(signoff ? [] : open.map((f) => `Apply fix ${f.n}, for ${f.cause}? Answer Apply or Skip.`)),
    ...run.followups.filter((f) => ['rollback', 'delete'].includes(f.verdict)).map((f) => `${f.verdict === 'delete' ? 'Delete' : 'Roll back'} change ${f.change}? Answer yes or no.`)];
  if (signoff) lines.push(`- Run learn-from-mistakes-axi signoff post. It sends each fix${applied.size ? ' the run did not apply' : ''} to sign-off as an Apply or Skip question.`);
  lines.push(...asks.map((q, i) => `${i + 1}. ${q}`));
  if (!signoff && !asks.length) lines.push('- No questions.');
  writeFileSync(join(dir, 'report.txt'), `${lines.join('\n')}\n`);
  return { lines: lines.length, questions: asks.length };
}
