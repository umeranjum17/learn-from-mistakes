// Incident mode: one failure the user names, apart from the retro. The run reads only what the user gave (free text, a
// file or a screenshot, a GitHub PR or issue, and each --evidence) plus the project context a retro reads, and writes one
// report: the timeline, the root causes, why no check caught it, how to avoid it and the fixes that stop it coming
// back, each with an owner, a priority and a due date. A fix stays open until it is recorded as applied
// (`change applied --proposal <run>:<n>`), it shipped, and its recorded check command passed: `incident --status` runs
// that check and lists the open fixes.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MEASURE, readLedger, shq, UsageError, withContext } from '../bin/learn-from-mistakes-axi.mjs';
import { evidenceOf } from './report-text.mjs';
import { plain, RAW, readBundle, bundleIds } from './check.mjs';
import { REASONS } from './context.mjs';
import { liveAt } from './merge-time.mjs';
import { redact } from './redact.mjs';
import { which } from './runners/index.mjs';

const ITEM_CHARS = 8000, ITEMS = 40, COMMENTS = 30; // the text the agents read per item, the items per run and the comments read per PR or issue
const FILE_CHARS = 65_536; // the text of a file the run saves: past ITEM_CHARS the bundle says it was cut
const GITHUB = /^https?:\/\/([^/\s]*github[^/\s]*)\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#]\S*)?$/i;
const IMAGE = [['png', [0x89, 0x50, 0x4e, 0x47]], ['jpeg', [0xff, 0xd8, 0xff]], ['gif', [0x47, 0x49, 0x46, 0x38]], ['webp', [0x52, 0x49, 0x46, 0x46]]];
const CHECK_MS = 600_000; // one check command's time limit
export const WHAT = 'learn-from-mistakes-axi incident "<what failed>" --wait 8m';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The items an incident run reads, in the order the user named them: `what` (text, a file, or a GitHub PR or issue link)
// then each --evidence (a file or a link). Each item is { id, ts, ref, text, data: { kind } }; an image keeps its size,
// since the run's agents read text only. A file or link that cannot be read stops the command before a run starts.
export function incidentItems(cfg, what, evidence = []) {
  const items = [];
  const add = (it) => items.push({ id: `i${items.length + 1}`, ts: null, ...it });
  const one = (arg, free) => {
    if (GITHUB.test(arg) || /^#\d+$/.test(arg)) return github(cfg, arg).forEach(add);
    if (/^[a-z][\w+.-]*:\/\//i.test(arg)) throw new UsageError(`${shown(arg)}: only a GitHub PR or issue link is read`, 'save the page as a file and pass its path, or paste its text');
    if (existsSync(arg) && statSync(arg).isFile()) return add(file(arg));
    if (!free) throw new UsageError(`--evidence ${shown(arg)}: no such file`, 'ls   # pass the path of a file that exists, or a GitHub PR or issue link');
    add({ ref: 'the incident text', text: arg, data: { kind: 'text' } });
  };
  one(what, true);
  for (const e of evidence) one(e, false);
  if (items.length > ITEMS) throw new UsageError(`the incident names ${items.length} items; an incident reads at most ${ITEMS}`, 'name fewer --evidence files or links: the ones that show the failure');
  return items;
}
const shown = (v) => JSON.stringify(v.length > 80 ? `${v.slice(0, 77)}...` : v);

// A file the user named: its text, or an image's kind, size and pixel size (a PNG's). Any other binary file is refused.
function file(path) {
  let buf;
  try { buf = readFileSync(path); } catch (e) { throw new UsageError(`${path}: cannot read (${e.code})`, `chmod u+r ${shq(path)}`); }
  const type = IMAGE.find(([, magic]) => magic.every((b, i) => buf[i] === b))?.[0];
  if (type) {
    const px = type === 'png' && buf.length >= 24 ? `, ${buf.readUInt32BE(16)} by ${buf.readUInt32BE(20)} pixels` : '';
    return { ref: path, text: `An image (${type}, ${Math.ceil(buf.length / 1024)} KB${px}). The agents read text only, so they cannot see it.`, data: { kind: 'image', name: basename(path) } };
  }
  if (buf.includes(0)) throw new UsageError(`${path}: not a text file or an image (png, jpeg, gif or webp)`, 'pass a text file, a screenshot, or a GitHub PR or issue link');
  return { ref: path, text: buf.toString('utf8').slice(0, FILE_CHARS), data: { kind: 'file', name: basename(path) } };
}

// A GitHub PR or issue, through the user's own `gh` login: its title and body, then each comment and review with text,
// with their times. `#<n>` names a PR or issue of the project's own repo. Never the authors' names.
function github(cfg, arg) {
  const bin = which('gh');
  if (!bin) throw new UsageError(`${arg}: gh is not on PATH, so the link cannot be read`, 'install the GitHub CLI (https://cli.github.com), then gh auth login; or paste the text instead');
  const m = GITHUB.exec(arg), target = m ? arg : arg.slice(1);
  const view = (kind, fields) => spawnSync(bin, [kind, 'view', target, '--json', fields], { cwd: cfg.dir, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20 });
  const kinds = m ? [m[4] === 'pull' ? 'pr' : 'issue'] : ['pr', 'issue'];
  let got, kind;
  for (kind of kinds) {
    got = view(kind, `number,title,body,url,createdAt,closedAt,comments${kind === 'pr' ? ',mergedAt,reviews' : ''}`);
    if (got.status === 0) break;
  }
  if (got.status !== 0) {
    const why = (got.stderr || got.error?.code || `exit ${got.status}`).trim().split('\n').at(-1).slice(0, 200);
    throw new UsageError(`${arg}: gh cannot read it (${why})`, /auth login|not logged in/i.test(why) ? 'gh auth login' : 'check the link, or paste the text instead');
  }
  let v;
  try { v = JSON.parse(got.stdout); } catch { throw new UsageError(`${arg}: gh gave no JSON`, 'gh --version   # update gh, or paste the text instead'); }
  const name = `${kind === 'pr' ? 'PR' : 'issue'} #${v.number}`;
  const when = [['opened', v.createdAt], ['merged', v.mergedAt], ['closed', v.closedAt]].filter(([, t]) => t).map(([w, t]) => `${name} ${w} at ${t}.`);
  const out = [{ ts: v.createdAt ?? null, ref: v.url ?? arg, text: `${name}: ${v.title ?? ''}\n${when.join(' ')}\n\n${v.body ?? ''}`, data: { kind, left: 0 } }];
  const notes = [...(v.comments ?? []).map((c) => ({ ts: c.createdAt, ref: c.url ?? v.url, text: c.body, what: 'comment' })),
    ...(v.reviews ?? []).map((r) => ({ ts: r.submittedAt, ref: v.url, text: [r.state && `Review: ${r.state.toLowerCase().replace(/_/g, ' ')}.`, r.body].filter(Boolean).join('\n'), what: 'review' }))]
    .filter((c) => c.text?.trim()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const c of notes.slice(0, COMMENTS)) out.push({ ts: c.ts ?? null, ref: c.ref ?? arg, text: `A ${c.what} on ${name}:\n${c.text}`, data: { kind: c.what } });
  out[0].data.left = Math.max(0, notes.length - COMMENTS); // the comments past the cap, named under Not checked
  return out;
}

// The read step: the one file the run's agents read, <run dir>/bundle.md, from the items saved with the run. Each item
// is redacted, cut at ITEM_CHARS characters, and quoted line by line, so no line of its text can read as an item id.
export function incidentBundle(db, id, dir, log) {
  const items = db.prepare('SELECT record_id, ts, text, data FROM records WHERE run_id = ? ORDER BY id').all(id);
  const label = { text: () => "the user's words", file: (d) => `the file ${d.name}`, image: (d) => `the screenshot ${d.name}`, pr: () => 'the pull request',
    issue: () => 'the issue', comment: () => 'a comment', review: () => 'a review' };
  let cut = 0;
  const lines = items.map((r) => {
    const d = JSON.parse(r.data), text = redact(r.text).replace(/\r\n?/g, '\n').trim();
    if (text.length > ITEM_CHARS) cut++;
    const quoted = text.slice(0, ITEM_CHARS).split('\n').map((l) => `  > ${l}`).join('\n');
    return `- [${r.record_id}] ${label[d.kind](d)}, ${r.ts ? redact(r.ts) : 'no time'}\n${quoted}`;
  });
  writeFileSync(join(dir, 'bundle.md'), `# Incident bundle

The one failure the user named, and the evidence they gave. Each item has an id in brackets: cite it in refs.

## Items

${lines.join('\n')}
`);
  const data = items.map((r) => JSON.parse(r.data));
  log(`bundle.md: ${items.length} items${cut ? `, ${cut} cut at ${ITEM_CHARS} characters` : ''}`);
  return { items: items.length, cut, images: data.filter((d) => d.kind === 'image').length, left: data.reduce((n, d) => n + (d.left ?? 0), 0) };
}

// The report for a person: <run dir>/report.txt. Each line a person reads keeps the report rules (short sentences, plain
// words, no ids or paths); pointers go on the Evidence, Owning tool, Test and Check lines only.
export function incidentReport(cfg, db, id, dir, log) {
  const all = (sql) => db.prepare(sql).all(id);
  const step = (name) => JSON.parse(db.prepare('SELECT output_json FROM steps WHERE run_id = ? AND name = ?').get(id, name)?.output_json ?? '{}');
  const evidence = (refs) => `   ${evidenceOf(cfg, db, id, { current_start: new Date(0).toISOString() })(refs)}`;
  const said = (text) => { const t = redact(text ?? '').replace(/\s+/g, ' ').trim(); return t && !plain(t, '', {}) && !RAW.test(t) ? t : 'This text breaks the report rules, so the report hides it.'; };
  const pointer = (text) => redact(text ?? '').replace(/\s+/g, ' ').trim();
  const lines = (name) => all(`SELECT head, text, refs_json FROM incident_lines WHERE run_id = ? AND step = '${name}' ORDER BY n`);
  const causes = all(`SELECT cause, summary, refs_json, verdict, judge_note, whys_json, cost FROM findings WHERE run_id = ? ORDER BY id`);
  const kept = causes.filter((c) => c.verdict !== 'refuted');
  const fixes = all('SELECT n, cause, kind, target, owner, change, test, priority, due, check_cmd, refs_json, verdict, judge_note FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n');
  const left = all('SELECT cause, problem FROM proposals WHERE run_id = ? AND problem IS NOT NULL ORDER BY id');
  const timeline = lines('timeline'), gates = lines('gates'), avoid = step('prevent').avoid ?? [];
  const out = ['Incident report', '', '1. Short answer',
    kept.length ? `- Root cause: ${said(JSON.parse(kept[0].whys_json).at(-1))}` : '- The run named no root cause the judge kept.',
    `- ${plural(gates.length, 'check')} did not catch it.`,
    `- ${plural(fixes.length, 'fix', 'fixes')} passed the rules. The judge confirmed ${fixes.filter((f) => f.verdict === 'confirmed').length} of them.`,
    '', '2. Timeline'];
  for (const t of timeline) out.push(`- ${t.head === 'unknown' ? 'Time unknown' : t.head}: ${said(t.text)}`, evidence(JSON.parse(t.refs_json)));
  if (!timeline.length) out.push('- The run gave no timeline.');
  out.push('', '3. Why it happened');
  for (const c of causes) {
    const whys = JSON.parse(c.whys_json ?? '[]');
    out.push(`- ${c.cause}: ${said(c.summary)}`, ...whys.slice(0, -1).map((w, i) => `   Why ${i + 1}: ${said(w)}`),
      `   Root cause: ${said(whys.at(-1))}`, `   Cost: ${said(c.cost)}`, `   The judge's verdict: ${c.verdict ?? 'not judged'}.`,
      ...(c.verdict === 'refuted' ? ['   The run proposes no fix for a cause the judge refuted.'] : []), evidence(JSON.parse(c.refs_json)));
  }
  if (!causes.length) out.push('- The run named no root cause.');
  out.push('', '4. Why no check caught it');
  for (const g of gates) out.push(`- ${said(g.head)}: ${said(g.text)}`, evidence(JSON.parse(g.refs_json)));
  if (!gates.length) out.push('- The run named no check.');
  out.push('', '5. How to avoid it now', ...(avoid.length ? avoid.map((a) => `- ${said(a)}`) : ['- The run gave no advice.']));
  out.push('', '6. Fixes that stop it coming back');
  for (const f of fixes) {
    out.push(`Fix ${f.n}, ${f.priority}, for ${f.cause}:`, `- Owner: ${said(f.owner).replace(/\.$/, '')}. Due: ${f.due}.`, `- Kind: ${f.kind}.`, `- Change: ${said(f.change)}`,
      `   Owning tool: ${pointer(f.target)}`, ...(f.test ? [`   Test: ${pointer(f.test)}`] : []), `   Check: ${pointer(f.check_cmd)}`,
      `- The judge's verdict: ${f.verdict ?? 'not judged'}.`, evidence(JSON.parse(f.refs_json)));
  }
  if (!fixes.length) out.push('- No fix passed the rules.');
  const read = step('read'), ctx = step('context');
  const uncited = [...bundleIds(readBundle(dir, id))].filter((r) => ![...causes, ...timeline, ...gates].some((x) => JSON.parse(x.refs_json).includes(r)));
  const gaps = [
    ...(read.images ? [`- The agents cannot see ${plural(read.images, 'image')}. Describe what it shows in text, and run the incident again.`] : []),
    ...(read.cut ? [`- The run cut ${plural(read.cut, 'item')} at ${ITEM_CHARS} characters.`] : []),
    ...(read.left ? [`- The run read the first ${COMMENTS} comments of a PR or issue and left ${read.left} out.`] : []),
    ...(uncited.length ? [`- No timeline entry, cause or check cites ${plural(uncited.length, 'item')}.`, evidence(uncited)] : []),
    ...(left.length ? [`- The rules left out ${plural(left.length, 'fix', 'fixes')}.`, ...left.map((f) => `   The fix for ${f.cause}: ${f.problem}.`)] : []),
    ...(fixes.some((f) => f.verdict === 'weakened') ? [`- The judge weakened ${plural(fixes.filter((f) => f.verdict === 'weakened').length, 'fix', 'fixes')}.`] : []),
    ...(ctx.off ? ['- The project context is off for this project, so the run saw no project rule.'] : ctx.read && !ctx.read.length ? ['- The project context read no project file.'] : []),
    ...(ctx.skipped?.length ? [`- The project context did not read ${plural(ctx.skipped.length, 'file')}: ${[...new Set(ctx.skipped.map((f) => f.why))].map((w) => REASONS[w].short).join(', ')}.`] : []),
  ];
  out.push('', '7. Not checked', ...(gaps.length ? gaps : ['- Nothing. The run read every item the user named.']), '', '8. Next steps');
  if (fixes.length) out.push('- Each fix stays open until it ships and its check passes.',
    `   Record a fix once it is made: learn-from-mistakes-axi change applied --proposal ${id}:<n> --ref <commit>`,
    '   Then run its check and list the open fixes: learn-from-mistakes-axi incident --status');
  else out.push('- No fix to track.');
  writeFileSync(join(dir, 'report.txt'), `${out.join('\n')}\n`);
  log(`report.txt: ${out.length} lines, ${plural(fixes.length, 'fix', 'fixes')}`);
  return { causes: kept.length, gates: gates.length, fixes: fixes.length, report_txt: join(dir, 'report.txt') };
}

// `incident --status`: every incident fix, open first. A fix is proposed, applied (a ledger entry records it), shipped
// (live on the default branch) and done once its recorded check command passes; this command runs that check for each
// shipped fix not done yet, in the project dir, and saves a pass. A fix whose ledger entry records no check of its own
// (the retro's measure command) is never run.
export function incidentStatus(cfg, db) {
  const { entries } = readLedger(join(cfg.state, 'changes.jsonl'));
  const recorded = new Map(entries.filter((e) => e.proposal).map((e) => [e.proposal, e]));
  const rows = db ? db.prepare(`SELECT p.id, p.run_id, p.n, p.cause, p.kind, p.owner, p.priority, p.due, p.check_cmd, p.passed_at FROM proposals p JOIN runs r ON r.id = p.run_id
    WHERE r.kind = 'incident' AND r.status = 'completed' AND p.n IS NOT NULL ORDER BY p.priority, p.due, p.run_id, p.n`).all() : [];
  const pass = db?.prepare('UPDATE proposals SET passed_at = ? WHERE id = ?');
  const logs = join(cfg.state, 'checks');
  const fixes = rows.map((p) => {
    const at = `${p.run_id}:${p.n}`, change = recorded.get(at), live = change && liveAt(cfg.dir, change);
    const f = { fix: at, cause: p.cause, kind: p.kind, priority: p.priority, owner: redact(p.owner), due: p.due, state: 'proposed', check: change?.check ?? p.check_cmd ?? '' };
    if (change) f.state = live.live ? 'shipped' : 'applied';
    if (p.passed_at) return { ...f, state: 'done', passed_at: p.passed_at };
    if (f.state !== 'shipped' || !change.check || change.check === MEASURE) return f;
    mkdirSync(logs, { recursive: true });
    const log = join(logs, `${p.run_id}-${p.n}.log`);
    const r = spawnSync('sh', ['-c', change.check], { cwd: cfg.dir, encoding: 'utf8', timeout: CHECK_MS, maxBuffer: 64 << 20 });
    appendFileSync(log, `$ ${change.check}\n${r.stdout ?? ''}${r.stderr ?? ''}exit: ${r.status ?? r.signal ?? r.error?.code}\n`);
    console.error(`check: fix ${at} ${r.status === 0 ? 'passed' : `failed (${r.status ?? r.signal ?? r.error?.code})`}: ${change.check}   # output in ${log}`);
    if (r.status !== 0) return { ...f, check_failed: true };
    const now = new Date().toISOString();
    pass.run(now, p.id);
    return { ...f, state: 'done', passed_at: now };
  });
  const open = fixes.filter((f) => f.state !== 'done');
  return { open: open.length, done: fixes.length - open.length, fixes: open };
}
export const incidentHint = (out, opts) => (out.open
  ? withContext(`learn-from-mistakes-axi change applied --proposal ${out.fixes.find((f) => f.state === 'proposed')?.fix ?? '<run>:<n>'} --ref <commit>`, 'record a fix once it is made; its check then runs here', opts)
  : withContext(WHAT, 'go deep on one failure', opts));
