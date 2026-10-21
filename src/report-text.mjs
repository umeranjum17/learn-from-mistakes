// The run's report for a person: <run dir>/report.txt, plain text in the seven sections of the plan. Each line a person
// reads is STE100: sentences of at most 20 words in plain words and the active voice, with no record id, session id or path. Those go only on the
// `Evidence:` lines, as pointers a person can open: file:line, `session <id> at <time>`, `PR #N` or a gate store row, and on the `applied:`
// line of a fix the run's apply step applied (its branch, commit and ledger id) and the `refused:` line of one it could not apply
// (the refusal and its `next:`).
// Text an agent or the config wrote is redacted and shown only when it keeps the plain-language rule.
import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { appliedFixes, appliedLine } from './apply.mjs';
import { clusters } from './bundle.mjs';
import { bundleIds, counts, plain, RAW, readBundle, splitSentences } from './check.mjs';
import { inWindow, rounded } from './metrics.mjs';
import { excerpt, redact } from './redact.mjs';
import { which } from './runners/index.mjs';
import { STAGES, WORKING } from './stages.mjs';

const EVIDENCE = 3; // pointers shown per item; the rest are counted
const UNCITED = 10, QUOTE = 100; // records listed per kind under Not checked (the rest are counted), and characters of each one's text
const DO = { keep: 'Keep it.', fix: 'Change it. The metric got better, but it missed the tripwire.', rollback: 'Roll it back.',
  delete: 'Delete it. It did not change the metric.', 'no-data': 'Wait for more data.' };
// This window against the last, in words; two numbers are needed to compare.
const trend = ({ current: a, previous: b }) => (typeof a !== 'number' || typeof b !== 'number' ? 'unknown' : a === b ? 'flat' : a > b ? 'up' : 'down');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
// Free text from an agent or the config, on its own line; text that breaks the sentence rule or names a RAW item is left out.
const said = (text) => {
  const t = redact(text ?? '').replace(/\s+/g, ' ').trim();
  return t && !plain(t, '', {}) && !RAW.test(t) ? `  ${t}` : '  This text breaks the report rules, so the report hides it.';
};

// A fix's change must be readable: propose checked it against these rules and sent it back once, so one that still
// breaks one shows trimmed — its leading sentences that follow the rules — and names the proposal that holds the
// rest (`change applied --proposal <run>:<n>` takes that id). Nothing readable says so and still names the proposal.
const changeLines = (text, at) => {
  const t = redact(text ?? '').replace(/\s+/g, ' ').trim();
  if (t && !plain(t, '', {}) && !RAW.test(t)) return [`  ${t}`];
  let good = '';
  for (const s of splitSentences(t)) {
    if (plain(s, '', {}) || RAW.test(s)) break;
    good = good ? `${good} ${s.trim()}` : s.trim();
  }
  return good ? [`  ${good}`, `   Proposal ${at}: the rest of this text breaks the report rules.`]
    : [`  This text breaks the report rules, so the report hides it.`, `   Proposal ${at} holds the text.`];
};

// `run` is the run as `status` shows it before the report step: its metrics, follow-ups, fixes and sources.
export function reportText(cfg, db, id, dir, window, run) {
  const all = (sql, ...args) => db.prepare(sql).all(id, ...args);
  const records = new Map(all('SELECT record_id, source, ref, text, data FROM records WHERE run_id = ?').map((r) => [r.record_id, r]));
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
  const labelled = new Map(all('SELECT record_id, cause, why FROM labels WHERE run_id = ?').map((l) => [l.record_id, l]));
  const { causes } = counts(cfg, db, id, window);
  const findings = all(`SELECT cause, summary, refs_json, verdict, whys_json, cost FROM findings WHERE run_id = ? AND verdict IS NOT 'refuted' ORDER BY id`);
  const fixes = all('SELECT n, cause, owner, change, refs_json, verdict, judge_note FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n');
  const reasons = new Map(all('SELECT change_id, reason FROM followups WHERE run_id = ?').map((f) => [f.change_id, f.reason]));
  const applied = appliedFixes(db, id);
  const step = (name) => JSON.parse(db.prepare('SELECT output_json FROM steps WHERE run_id = ? AND name = ?').get(id, name)?.output_json ?? '{}');
  const refused = new Map((step('apply').refused ?? []).map((r) => [r.fix, r]));
  const repeated = [...causes].filter(([, c]) => c.repeated);
  const missed = run.metrics.filter((m) => m.met === 'missed').length;
  const lines = ['Retro report', '', '1. Short answer',
    repeated.length ? `- ${plural(repeated.length, 'mistake')} came back in this window.` : '- No mistake came back in this window.',
    `- ${plural(fixes.length, 'fix', 'fixes')} passed the rules. The judge confirmed ${fixes.filter((f) => f.verdict === 'confirmed').length} of them.`,
    `- ${plural(missed, 'metric')} missed the target.`, '', '2. Numbers'];
  const measured = run.metrics.filter((m) => m.target || m.current !== 'n/a' || m.previous !== 'n/a'); // the rest have no data
  const JOB = 'ci_job_failures:', jobs = measured.filter((m) => m.name.startsWith(JOB)).sort((a, b) => b.current - a.current || b.previous - a.previous);
  for (const m of measured.filter((x) => !x.name.startsWith(JOB))) lines.push(`- ${m.name}: this window ${m.current}, last window ${m.previous}, trend ${trend(m)}, ${m.target ? `target ${m.target}, ${m.met === 'n/a' ? 'no data' : m.met}` : 'no target'}.`);
  if (!measured.length) lines.push('- No metric has data.');
  // Failing CI jobs by name, the worst first; the rest are counted.
  for (const m of jobs.slice(0, EVIDENCE * 3)) lines.push(`- CI job ${m.name.slice(JOB.length)}: failed ${plural(m.current, 'time')} this window, ${m.previous} last window, trend ${trend(m)}.`);
  if (jobs.length > EVIDENCE * 3) lines.push(`- ${plural(jobs.length - EVIDENCE * 3, 'more failing CI job')} not shown.`);
  // Where the time goes: the work against the waits, then the three longest waits with their cause and the fix.
  const hours = (metric) => run.metrics.find((m) => m.name === metric)?.current;
  const waits = Object.values(STAGES).map((s) => ({ ...s, hours: hours(s.metric) })).filter((s) => typeof s.hours === 'number' && s.hours > 0).sort((a, b) => b.hours - a.hours);
  if (typeof hours(WORKING.metric) === 'number') {
    const waiting = waits.reduce((n, s) => n + s.hours, 0);
    lines.push(`- Where the time goes: ${rounded(hours(WORKING.metric))} hours of work and ${rounded(waiting)} hours of waiting, over ${plural(hours('tasks_timed'), 'task')}.`);
    waits.slice(0, 3).forEach((s, i) => lines.push(`- Slowest wait ${i + 1}, ${s.label}: ${rounded(s.hours)} hours, ${Math.round(100 * s.hours / waiting)}% of the waiting.`, `   Cause: ${s.cause}`, `   Fix: ${s.fix}`));
  }
  // Each home of a fleet, by salted id: its share of the fleet numbers above, this window.
  const homes = new Map(run.sources.flatMap((s) => s.homes ?? []).map((h) => [h, {}]));
  for (const r of inWindow(all('SELECT ts, data FROM records WHERE run_id = ? AND ts IS NOT NULL'), { start: Date.parse(window.current_start) })) {
    const { home, kind } = JSON.parse(r.data ?? '{}'), n = homes.get(home);
    if (n) n[kind] = (n[kind] ?? 0) + 1;
  }
  for (const [home, n] of homes) lines.push(`- Home ${home}: ${['decision', 'block', 'steer', 'defect'].map((k) => plural(n[k] ?? 0, k)).join(', ')} this window.`);
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
    // The retro method per mistake: its cost, how often it came back, the root cause the why chain reached, and its fix.
    const finding = findings.find((f) => f.cause === cause && f.whys_json), whys = finding ? JSON.parse(finding.whys_json) : [];
    const fix = fixes.filter((f) => f.cause === cause).map((f) => f.n);
    lines.push(`- ${cause}: ${plural(c.count, 'time')} on ${plural(c.days, 'day')}.`,
      `   Cost: ${finding ? said(finding.cost).trim() : 'No finding gave a cost.'}`,
      ...whys.slice(0, -1).map((w, i) => `   Why ${i + 1}: ${said(w).trim()}`),
      `   Root cause: ${whys.length ? said(whys.at(-1)).trim() : 'No finding gave a root cause.'}`,
      `   Fix: ${fix.length ? `see fix ${fix.join(', ')} in section 5.` : 'No fix passed the rules for this mistake.'}`, evidence(refs));
  }
  if (!repeated.length) lines.push('- None.');
  // Records exist but none is dated inside the window: say so, so an empty report does not read as a quiet week.
  const dated = [...all('SELECT ts FROM events WHERE run_id = ? AND ts IS NOT NULL'), ...all('SELECT ts FROM records WHERE run_id = ? AND ts IS NOT NULL')];
  if (!repeated.length && dated.length && !inWindow(dated, { start: Date.parse(window.current_start) }).length) lines.push(`- The sources have records, but all fall outside the ${parseInt(cfg.window, 10)}-day window.`);
  lines.push('', '5. Fixes');
  for (const f of fixes) {
    const refs = JSON.parse(f.refs_json);
    const finding = findings.find((x) => x.cause === f.cause && JSON.parse(x.refs_json).some((r) => refs.includes(r))) ?? findings.find((x) => x.cause === f.cause);
    const shown = run.fixes.find((x) => x.n === f.n);
    const target = run.metrics.find((m) => m.name === shown.metric)?.target;
    lines.push(`Fix ${f.n}, for ${f.cause}:`, '- Finding:', said(finding?.summary ?? cfg.causes[f.cause]?.description), '- Owner:', said(f.owner), '- Change:',
      ...changeLines(f.change, `${id}:${f.n}`),
      `- Metric: ${shown.metric}, ${target ? `target ${target}` : 'no target'}. Tripwire: ${shown.tripwire}.`, `- The judge's verdict: ${shown.verdict}.`);
    if (f.judge_note) lines.push(said(f.judge_note));
    lines.push(evidence(JSON.parse(f.refs_json)));
    if (applied.has(f.n)) lines.push(`   ${appliedLine(id, applied.get(f.n))}`);
    else if (refused.get(f.n)) lines.push(`   refused: fix ${id}:${f.n} was not applied: ${refused.get(f.n).why}`, `   next: ${refused.get(f.n).next}`);
  }
  if (!fixes.length) lines.push('- No fix passed the rules.');
  const judged = (verdict) => [...fixes, ...findings].filter((x) => x.verdict === verdict).length; // the kept fixes and the findings counted above
  // Every complaint and defect record the worker read is cited by a kept finding or named here, so none vanishes without a trace.
  const cited = new Set(findings.flatMap((f) => JSON.parse(f.refs_json)));
  const uncited = [...bundleIds(readBundle(dir, id))].filter((r) => records.has(r) && !cited.has(r));
  const gaps = [...run.sources.filter((s) => !s.items).map((s) => `- Source ${s.id} gave no records.`),
    ...run.sources.filter((s) => s.skipped).map((s) => `- Source ${s.id} skipped ${plural(s.skipped, 'session')}.`),
    ...run.sources.filter((s) => s.undated).map((s) => `- Source ${s.id} read ${plural(s.undated, 'record')} and none has a date, so the window placed none of them. Add a "## YYYY-MM-DD" heading above its bullets, or a date in each bullet.`),
    ...run.sources.flatMap((s) => (s.missing ?? []).map((m) => `- Source ${s.id} gave no ${m}.`)),
    ...run.sources.filter((s) => s.lines_skipped).map((s) => `- Source ${s.id} skipped ${plural(s.lines_skipped, 'home line')} with no local home.`),
    ...[[true, 'captain complaint'], [false, 'defect record']].flatMap(([complaint, word]) => {
      const rs = uncited.filter((r) => (JSON.parse(records.get(r).data ?? '{}').kind === 'complaint') === complaint);
      // Each record shows its own text (cut short, and only when excerpts are on) so a reader knows which mistake it is; a worker's `other` label is named with its reason.
      const quote = (t) => { const e = excerpt(t ?? ''); return e.length > QUOTE ? `${e.slice(0, QUOTE - 3)}...` : e; };
      return rs.length ? [`- No finding cites ${plural(rs.length, word)}.`, ...rs.slice(0, UNCITED).flatMap((r) => [evidence([r]),
        ...(cfg.excerpts === 'off' || !records.get(r).text ? [] : [`   Text: ${quote(records.get(r).text)}`]),
        ...(labelled.get(r)?.cause === 'other' ? [`   The worker labelled it other${labelled.get(r).why ? `: ${quote(labelled.get(r).why)}` : '.'}`] : [])]),
        ...(rs.length > UNCITED ? [`   And ${rs.length - UNCITED} more.`] : [])] : [];
    }),
    ...[[step('analyse').labels_dropped, 'The worker broke the rules on', 'label'],
      [step('analyse').findings_style, 'The worker broke the style rules in', 'finding'],
      [all('SELECT count(*) AS n FROM proposals WHERE run_id = ? AND problem IS NOT NULL')[0].n, 'The rules left out', 'fix', 'fixes'],
      [judged('weakened'), 'The judge weakened'], [judged(null), 'The judge did not check']]
      .filter(([n]) => n).flatMap(([n, what, word = 'item', many]) => [`- ${what} ${plural(n, word, many)}.`,
        ...(what === 'The worker broke the style rules in' ? ['   The run kept them, and the report hides any wording that breaks the rules.'] : []),
        ...(what === 'The rules left out' ? all('SELECT cause, problem FROM proposals WHERE run_id = ? AND problem IS NOT NULL ORDER BY id').map((f) => `   The fix for ${f.cause}: ${f.problem}.`) : [])])];
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
