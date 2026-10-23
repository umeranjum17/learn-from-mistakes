// End-to-end: incident mode. One made-up failure named as text, a file, a screenshot, a GitHub PR or issue link (through
// a fake gh), each run through the real CLI with the fake agent as worker and judge, into one report.txt; the fixes are
// tracked in the change ledger until their check passes; a packed install gives the same report. The PATH holds only
// the fakes, node, git and the shell tools a check runs: no Firstmate, no sign-off. LFM_CLI points the journeys at an
// installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';

const REPO = new URL('..', import.meta.url).pathname;
const CLI = process.env.LFM_CLI || join(REPO, 'bin', 'learn-from-mistakes-axi.mjs');
const FAKE = join(REPO, 'test', 'fake-agent', 'claude');
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';
const STACK = /\n\s+at [^\n]*:\d+:\d+/;
const TEXT = 'Umer approved the feel-v2 board prototype, but the shipped board differed from it.';
// A fake gh: `pr view` and `issue view` with --json, for one made-up PR and one made-up issue; #7 is only an issue.
const FAKE_GH = `const [kind, , target] = process.argv.slice(2);
const pr = { number: 12, title: 'Ship the feel-v2 board', body: 'Umer approved the prototype.', url: 'https://github.com/umer/board/pull/12',
  createdAt: '2026-10-20T09:00:00Z', mergedAt: '2026-10-21T10:00:00Z', closedAt: '2026-10-21T10:00:00Z',
  comments: [{ author: { login: 'umer-login-canary' }, body: 'The shipped board uses the old layout.', createdAt: '2026-10-22T08:00:00Z', url: 'https://github.com/umer/board/pull/12#issuecomment-1' }],
  reviews: [{ author: { login: 'umer-login-canary' }, state: 'APPROVED', body: 'Looks fine to Umer.', submittedAt: '2026-10-21T09:00:00Z' }] };
const issue = { number: 7, title: 'Board differs from the approved prototype', body: 'Umer saw the drift.', url: 'https://github.com/umer/board/issues/7',
  createdAt: '2026-10-22T09:00:00Z', closedAt: null, comments: [] };
const out = kind === 'pr' && /pull\\/12$/.test(target) ? pr : kind === 'issue' && /^(7|.*issues\\/7)$/.test(target) ? issue : null;
if (!out) { console.error(kind === 'pr' ? 'no pull requests found' : 'Could not resolve to an issue'); process.exit(1); }
console.log(JSON.stringify(out));`;
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());

// A plain project with a defect log, notes.md and a screenshot, a private HOME and LFM_HOME, and a PATH of fakes only.
function project({ gh = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-incident-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'p'), bin = join(tmp, 'bin'), home = join(tmp, 'home'), lfmHome = join(tmp, 'lfm');
  for (const d of [p, bin, home, lfmHome]) mkdirSync(d);
  writeFileSync(join(lfmHome, 'config.yaml'), AGENTS_SET);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources: { log: { type: markdown-log, path: defects.md } }\n');
  writeFileSync(join(p, 'defects.md'), `## ${new Date().toISOString().slice(0, 10)}\n- Umer: the build failed.\n`);
  writeFileSync(join(p, 'notes.md'), 'Umer saw the old layout on the shipped board.\n');
  writeFileSync(join(p, 'board.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 4, 0, 0, 0, 3, 0])]));
  for (const name of ['claude', 'codex']) symlinkSync(FAKE, join(bin, name));
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const tool of ['git', 'sh', 'grep']) symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, tool)).find(existsSync), join(bin, tool));
  if (gh) writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n${FAKE_GH}`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin, HOME: home, LFM_HOME: lfmHome, SIGN_OFF_HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: tmp };
  const lfm = (args, extra = {}, cli = CLI) => spawnSync(cli === CLI ? process.execPath : cli, [...(cli === CLI ? [CLI] : []), ...args, '--dir', p], { encoding: 'utf8', env: { ...env, ...extra } });
  return { p, lfm, env };
}
const runOf = (r) => { assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stderr, STACK); return JSON.parse(r.stdout); };
const reportOf = (out) => readFileSync(out.result.report_txt, 'utf8');

test('an incident from text, a file and a screenshot gives one report: timeline, root cause, the checks that missed it, how to avoid it, and dated fixes', () => {
  const { p, lfm } = project();
  const out = runOf(lfm(['incident', TEXT, '--evidence', join(p, 'notes.md'), '--evidence', join(p, 'board.png'), '--foreground', '--json']));
  assert.equal(out.kind, 'incident');
  assert.deepEqual(out.steps.map((s) => [s.name, s.status]), ['read', 'context', 'timeline', 'causes', 'verify', 'gates', 'prevent', 'verify-fixes', 'check', 'report'].map((s) => [s, 'completed']));
  assert.deepEqual(out.fixes.map((f) => [f.n, f.kind, f.priority, f.verdict]), [[1, 'code', 'P0', 'confirmed'], [2, 'rule', 'P1', 'confirmed']]);
  assert.equal(out.result.summary, 'root causes: spec-not-pinned; fixes: 2');
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(out.run.id), 'bundle.md'), 'utf8');
  assert.match(bundle, /^- \[i1\] the user's words, no time\n {2}> Umer approved the feel-v2/m);
  assert.match(bundle, /^- \[i2\] the file notes\.md, no time\n {2}> Umer saw the old layout/m);
  assert.match(bundle, /^- \[i3\] the screenshot board\.png, no time\n {2}> An image \(png, 1 KB, 1024 by 768 pixels\)/m);
  const report = reportOf(out), due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(report.split('\n').filter((l) => /^\d\. /.test(l)).join('|'),
    '1. Short answer|2. Timeline|3. Why it happened|4. Why no check caught it|5. How to avoid it now|6. Fixes that stop it coming back|7. Not checked|8. Next steps');
  assert.match(report, /^- Root cause: No step pins the approved prototype to the build\.$/m);
  assert.match(report, /^- Time unknown: The owner approved the prototype for Umer\.\n {3}Evidence: the incident text$/m);
  assert.match(report, /^- spec-not-pinned: The build did not pin the approved prototype\. The board drifted from it\.\n {3}Why 1: .*\n {3}Why 2: .*\n {3}Root cause: .*\n {3}Cost: .*\n {3}The judge's verdict: confirmed\.$/m);
  assert.match(report, /^- The visual review: It compared the board with the old design, not the approved one\.$/m);
  assert.match(report, /^- Compare the board with the approved prototype by hand before each merge\.$/m);
  assert.ok(report.includes(`Fix 1, P0, for spec-not-pinned:\n- Owner: maintainer. Due: ${due}.\n- Kind: code.\n- Change: Compare the shipped board with the approved prototype before the merge.\n`
    + '   Owning tool: the board renderer\n   Test: test/board.test.mjs: the board matches the approved prototype\n   Check: npm test\n'), report);
  assert.match(report, /^- The agents cannot see 1 image\. Describe what it shows in text, and run the incident again\.$/m);
  assert.match(report, new RegExp(`change applied --proposal ${out.run.id}:<n> --ref <commit>`));
  // The retro's own commands never take an incident run as the last retro.
  const report2 = lfm(['report']);
  assert.equal(report2.status, 3, report2.stderr);
  assert.match(lfm(['apply']).stderr, /^error: no retro run has kept fixes/m);
});

test('a GitHub PR link, an issue link and #<n> are read through gh: title, body, comments and reviews with their times, never an author name', () => {
  const { p, lfm } = project({ gh: true });
  const pr = runOf(lfm(['incident', 'https://github.com/umer/board/pull/12', '--evidence', 'https://github.com/umer/board/issues/7', '--foreground', '--json']));
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(pr.run.id), 'bundle.md'), 'utf8');
  assert.match(bundle, /^- \[i1\] the pull request, 2026-10-20T09:00:00Z\n {2}> PR #12: Ship the feel-v2 board\n {2}> PR #12 opened at 2026-10-20T09:00:00Z\. PR #12 merged at 2026-10-21T10:00:00Z\./m);
  assert.match(bundle, /^- \[i2\] a review, 2026-10-21T09:00:00Z\n {2}> A review on PR #12:\n {2}> Review: approved\./m);
  assert.match(bundle, /^- \[i3\] a comment, 2026-10-22T08:00:00Z\n {2}> A comment on PR #12:\n {2}> The shipped board uses the old layout\./m);
  assert.match(bundle, /^- \[i4\] the issue, 2026-10-22T09:00:00Z\n {2}> issue #7: Board differs/m);
  assert.doesNotMatch(bundle, /umer-login-canary/);
  const report = reportOf(pr);
  assert.match(report, /^- 2026-10-20: The owner approved the prototype for Umer\.\n {3}Evidence: https:\/\/github\.com\/umer\/board\/pull\/12$/m);
  assert.match(report, /Evidence: https:\/\/github\.com\/umer\/board\/pull\/12#issuecomment-1/);
  const issue = runOf(lfm(['incident', '#7', '--foreground', '--json'])); // not a PR: read as an issue of the project's own repo
  assert.match(readFileSync(join(p, '.lfm', 'runs', String(issue.run.id), 'bundle.md'), 'utf8'), /^- \[i1\] the issue, /m);
  const gone = lfm(['incident', 'https://github.com/umer/board/pull/99']);
  assert.equal(gone.status, 2);
  assert.match(gone.stderr, /^error: https:\/\/github\.com\/umer\/board\/pull\/99: gh cannot read it \(no pull requests found\)\nnext: /m);
});

test('a fix with no owner, a code fix with no regression test, a fix with no due date and advice that breaks the rules are refused, and the report names each rule', () => {
  const { lfm } = project();
  const out = runOf(lfm(['incident', TEXT, '--foreground', '--json'], { FAKE_INCIDENT: 'refused' }));
  assert.deepEqual(out.fixes.map((f) => f.priority), ['P0', 'P1'], 'a fix that broke a rule was numbered');
  const report = reportOf(out);
  assert.match(report, /^- The rules left out 3 fixes\.\n {3}The fix for spec-not-pinned: no owner; the owner is the role that makes the change\.\n {3}The fix for spec-not-pinned: no regression test; a code fix names the test that would have failed on this incident\.\n {3}The fix for spec-not-pinned: no due date; give the day it is due as YYYY-MM-DD\.$/m);
  const log = readFileSync(join(out.result.report_txt, '..', 'prevent.log'), 'utf8');
  assert.match(log, /^worker answer 1 is not valid: fixes\[2\]: no owner/m); // the first answer is sent back once with the rules
  assert.match(log, /^fixes: 5 given, 3 refused$/m);
  assert.match(log, /^worker answer 1 is not valid: .*avoid must be a list of 1 to 3 strings, each one sentence/m); // the advice is sent back too
  assert.match(report, /^5\. How to avoid it now\n- The run gave no advice\.$/m);
  assert.match(report, /^- The worker's advice on how to avoid it broke the report rules, so the report shows none\.$/m);
});

test('an incident fix is open until it is recorded, it shipped and its check passed; a later retro tracks it in the change ledger', () => {
  const { p, lfm } = project();
  const out = runOf(lfm(['incident', TEXT, '--foreground', '--json']));
  const status = (r = lfm(['incident', '--status', '--json'])) => runOf(r);
  const open = status();
  assert.deepEqual([open.open, open.done], [2, 0]);
  assert.deepEqual(open.fixes.map((f) => [f.fix, f.owner, f.priority, f.state, f.check]), [[`${out.run.id}:1`, 'maintainer', 'P0', 'proposed', 'npm test'], [`${out.run.id}:2`, 'maintainer', 'P1', 'proposed', 'grep -q prototype AGENTS.md']]);
  assert.match(open.fixes[0].due, /^\d{4}-\d{2}-\d{2}$/);
  // Recorded: its cause is the incident's own, which the config does not list; its kind and check come from the fix.
  const change = lfm(['change', 'applied', '--proposal', `${out.run.id}:2`, '--ref', 'abc1234', '--json']);
  assert.equal(change.status, 0, change.stderr);
  assert.deepEqual((({ cause, kind, proposal, check }) => ({ cause, kind, proposal, check }))(JSON.parse(change.stdout)), { cause: 'spec-not-pinned', kind: 'rule', proposal: `${out.run.id}:2`, check: 'grep -q prototype AGENTS.md' });
  const failing = lfm(['incident', '--status', '--json']);
  assert.match(failing.stderr, new RegExp(`^check: fix ${out.run.id}:2 failed \\(2\\): grep -q prototype AGENTS\\.md   # output in .*checks/${out.run.id}-2\\.log$`, 'm'));
  assert.deepEqual(status(failing).fixes.map((f) => [f.fix, f.state]), [[`${out.run.id}:1`, 'proposed'], [`${out.run.id}:2`, 'shipped']]);
  writeFileSync(join(p, 'AGENTS.md'), '- Name the approved prototype in the task brief.\n'); // the rule fix, made
  const passing = status();
  assert.deepEqual([passing.open, passing.done, passing.fixes.map((f) => f.fix)], [1, 1, [`${out.run.id}:1`]]);
  assert.equal(status().done, 1, 'a passed fix ran its check again'); // done stays done
  // A later retro's follow-ups: the recorded fix worked (its check passed), the other is not applied yet.
  const retro = lfm(['retro', '--foreground', '--json']);
  assert.equal(retro.status, 0, retro.stderr);
  const last = JSON.parse(retro.stdout);
  assert.deepEqual(last.followups.map((f) => [f.change, f.applied, f.shipped, f.worked]), [['chg-1', 'yes', 'yes', 'yes'], [`${out.run.id}:1`, 'no', 'no', 'not yet']]);
});

test('bad incident input is refused with error: and next:, never a stack trace', () => {
  const { p, lfm } = project();
  writeFileSync(join(p, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  for (const [args, error] of [
    [['incident'], /^error: incident needs the failure: /m],
    [['incident', '--status', TEXT], /^error: incident --status takes no failure/m],
    [['incident', TEXT, '--evidence', join(p, 'missing.md')], /^error: --evidence ".*missing\.md": no such file/m],
    [['incident', 'https://example.com/a/page'], /^error: "https:\/\/example\.com\/a\/page": only a GitHub PR or issue link is read/m],
    [['incident', TEXT, '--evidence', join(p, 'blob.bin')], /^error: .*blob\.bin: not a text file or an image/m],
    [['incident', 'https://github.com/umer/board/pull/12'], /^error: https:\/\/github\.com\/umer\/board\/pull\/12: gh is not on PATH/m],
    [['incident', TEXT, 'more words'], /^error: unexpected argument "more words"/m],
  ]) {
    const r = lfm(args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, error);
    assert.match(r.stderr, /^next: /m);
    assert.doesNotMatch(r.stderr, STACK);
  }
  assert.ok(!existsSync(join(p, '.lfm', 'lfm.sqlite')), 'a refused incident started a run');
});

test('a clean packed install gives the same incident report as the repo, with no Firstmate and no sign-off installed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-incident-pack-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const pack = join(tmp, 'pack'), prefix = join(tmp, 'prefix');
  mkdirSync(pack);
  execFileSync('npm', ['pack', '--pack-destination', pack], { cwd: REPO, stdio: 'ignore' });
  execFileSync('npm', ['install', '-g', '--prefix', prefix, join(pack, readdirSync(pack).find((f) => f.endsWith('.tgz')))], { stdio: 'ignore' });
  const installed = join(prefix, 'bin', 'learn-from-mistakes-axi');
  const reports = [CLI, installed].map((cli) => {
    const { p, lfm } = project();
    const out = runOf(lfm(['incident', TEXT, '--evidence', join(p, 'notes.md'), '--foreground', '--json'], {}, cli));
    assert.equal(out.run.status, 'completed', `${cli}: ${JSON.stringify(out.steps)}`);
    return reportOf(out);
  });
  assert.equal(reports[1], reports[0]);
  assert.match(reports[1], /^Fix 1, P0, for spec-not-pinned:$/m);
});
