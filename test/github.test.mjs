// End-to-end: init and a retro with a github source in a throwaway git repo whose origin is on GitHub. PATH holds a fake
// gh that records its argv and answers with synthetic GraphQL pages written here, plus git and two fake agent CLIs; no
// call reaches GitHub. The pages give known first-pass, hours-to-merge, rework, revert and escape numbers in both windows,
// and repeat a PR across two pages, as a PR updated between the two reads would be.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parse } from 'yaml';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const FAKE_AGENT = new URL('fake-agent/claude', import.meta.url).pathname;
const SECRET = `gh${'p_'}${'Z'.repeat(36)}`; // built here, so no key-shaped string sits in the repo
const FAKE_GH = `
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.FAKE_LOG, 'gh.jsonl'), JSON.stringify(args) + '\\n');
if (process.env.FAKE_GH === 'logged-out') { console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4); }
if (args[0] === 'auth') { console.log('github.com: Logged in to github.com account umer'); process.exit(0); }
const after = args.find((a) => a.startsWith('after='))?.slice(6) ?? 'first';
process.stdout.write(fs.readFileSync(path.join(process.env.FAKE_PAGES, after + '.json')));
`;
const NOW = Date.now(); // one clock for every page, so a PR's open and merge times differ by whole hours
const ago = (hours) => new Date(NOW - hours * 3_600_000).toISOString();
// A PR merged `merged` hours ago after `open` hours open; commits are [hours ago, check state] pairs.
// A commit is [hours ago, check state, parents]; parents defaults to 1 (a merge commit has 2).
function pr(number, title, { open = 1, merged, body = '', bot = false, commits, total } = {}) {
  commits ??= [[merged + open + 1, 'SUCCESS']]; // one commit, before the PR opened
  return { number, title, body, author: { __typename: bot ? 'Bot' : 'User', login: bot ? 'dependabot' : 'umer' },
    createdAt: ago(merged + open), updatedAt: ago(merged), mergedAt: ago(merged),
    labels: { nodes: [{ name: 'demo' }] }, reviews: { nodes: [{ state: 'APPROVED' }] },
    commits: { totalCount: total ?? commits.length, nodes: commits.map(([h, state, parents = 1]) => ({ commit: { authoredDate: ago(h),
      parents: { totalCount: parents }, statusCheckRollup: { state } } })) } };
}
const page = (nodes, next) => JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: next }, nodes } } } });

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-github-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'umer-app'), bin = join(tmp, 'bin'), log = join(tmp, 'log'), pages = join(tmp, 'pages');
  for (const d of [p, bin, log, pages]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['-C', p, 'init', '-q']);
  execFileSync('git', ['-C', p, 'remote', 'add', 'origin', 'git@github.com:umer/umer-app.git']);
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(bin, 'git'));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}\n${FAKE_GH}`);
  writeFileSync(join(bin, 'opencode'), '#!/bin/sh\necho "1.0.0"\n');
  for (const name of ['gh', 'opencode']) chmodSync(join(bin, name), 0o755);
  symlinkSync(FAKE_AGENT, join(bin, 'claude')); // the analyse step's worker, with node for its #! line
  symlinkSync(process.execPath, join(bin, 'node'));
  // Two pages, newest update first; the second ends with a PR updated before the read range, so no third page is asked for.
  const demo = pr(10, 'feat: add a demo page', { open: 4, merged: 26, body: `Umer's page. Demo value: ${SECRET}` }); // first pass
  writeFileSync(join(pages, 'first.json'), page([
    pr(20, 'feat: sync with main', { open: 5, merged: 2, commits: [[8, 'SUCCESS'], [4, 'FAILURE', 2]] }), // a base-branch merge after open: not rework
    pr(19, 'Fixture update', { merged: 3, body: 'New pages for #10.' }), // not a fix: no escape from #10
    pr(13, 'chore(deps): bump yaml', { merged: 4, bot: true }), // 1 h, a bot: not in first_pass
    pr(18, 'Reverted #3', { merged: 6 }), // reverts #3
    pr(17, 'Fixes #12 retry loop', { merged: 8 }), // escapes #12
    pr(16, 'fix: keep an empty body', { merged: 11, body: 'Follow-up to #5; see #110, other-org/lib#10 and other/lib#7.' }), // escapes #5, never #11 or other repos' #10, #7
    pr(14, 'Revert "feat: add retries"', { merged: 19, body: 'Reverts umer/umer-app#12' }), // reverts #12
    demo,
  ], 'second'));
  writeFileSync(join(pages, 'second.json'), page([
    demo, // updated again between the two reads: counted once
    pr(11, 'feat: add a form', { open: 10, merged: 40, commits: [[52, 'FAILURE'], [46, 'SUCCESS'], [44, 'SUCCESS']] }), // CI rework, then other rework
    pr(12, 'feat: add retries', { open: 2, merged: 58 }),
    pr(5, 'feat: parse the body', { open: 10, merged: 200 }), // last window; escaped
    pr(6, 'feat: a long branch', { open: 5, merged: 215, total: 150 }), // last window; partial
    pr(3, 'feat: a small tweak', { merged: 230 }), // last window; reverted
    pr(2, 'feat: old work', { merged: 400 }), // before the read range of two 7d windows
  ], 'third'));
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), FAKE_LOG: log, FAKE_PAGES: pages };
  const lfm = (extra, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, ...extra } });
  const calls = () => (existsSync(join(log, 'gh.jsonl')) ? readFileSync(join(log, 'gh.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { tmp, p, bin, lfm, calls };
}

test('init finds the GitHub origin; a retro reads its merged PRs through gh into both windows\' numbers', () => {
  const { p, lfm, calls } = setup();
  const init = lfm({}, 'init', '--json');
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(parse(readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8')).sources, { prs: { type: 'github' } });
  assert.deepEqual(calls(), [['auth', 'status']]);

  const r = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(r.stdout);
  assert.deepEqual(run.sources, [{ id: 'prs', type: 'github', items: 13 }]); // 13 PRs merged in the range; #2 is older
  const numbers = Object.fromEntries(run.metrics.filter((m) => !/^(defects|tool_error|corrections|interrupts|retries)/.test(m.name)).map((m) => [m.name, [m.current, m.previous]]));
  assert.deepEqual(numbers, {
    merged: [10, 3], first_pass: [77.8, 33.3], p50_hours_to_merge: [1, 5], p90_hours_to_merge: [5, 10],
    rework_ci: [1, 0], rework_other: [1, 0], reverted: [1, 1], escaped: [1, 1],
  });
  const gql = calls().slice(1);
  assert.equal(gql.length, 2, 'the read stops at the first PR updated before the range');
  assert.deepEqual(gql[0].slice(0, 2), ['api', 'graphql']);
  assert.ok(gql[0].includes('owner=umer') && gql[0].includes('name=umer-app') && !gql[0].some((a) => a.startsWith('after=')));
  assert.ok(gql[1].includes('after=second'));
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  assert.match(readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'bundle.md'), 'utf8'), /^- \[prs:10\] prs at PR #10, /m);
  writeFileSync(join(p, '.lfm', 'labels.jsonl'), JSON.stringify({ id: 'prs:10', event: false, why: 'a merged PR' }) + '\n');
  const labelled = lfm({}, 'report');
  assert.equal(labelled.status, 0, labelled.stderr);

  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try {
    const rows = Object.fromEntries(db.prepare(`SELECT ref, text, data FROM records WHERE source = 'prs'`).all().map((x) => [x.ref, x]));
    assert.match(rows['PR #10'].text, /^feat: add a demo page\n\nUmer's page\. Demo value: \[redacted\]$/);
    assert.equal(JSON.parse(rows['PR #6'].data).partial, true);
    assert.equal(JSON.parse(rows['PR #10'].data).escaped, false);
    assert.deepEqual(JSON.parse(rows['PR #11'].data), { bot: false, hours: 10, rework_ci: 1, rework_other: 1, reverted: false, escaped: false,
      partial: false, labels: ['demo'], changes_requested: 0 });
  } finally { db.close(); }

  const cfg = join(p, '.learn-from-mistakes.yaml');
  // A record id is printed as the store keeps it, even when its source id holds a key word, so the worker's labels name it.
  const plain = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, plain.replace(/^(\s+)prs:/m, '$1gh-token-prs:'));
  const keyed = lfm({ FAKE_ANALYSE: 'label' }, 'retro', '--foreground', '--json');
  assert.equal(keyed.status, 0, keyed.stderr);
  const keyedRun = JSON.parse(keyed.stdout).run.id;
  assert.match(readFileSync(join(p, '.lfm', 'runs', String(keyedRun), 'bundle.md'), 'utf8'), /^- \[gh-token-prs:10\] gh-token-prs at PR #10, /m);
  const kdb = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try { assert.ok(kdb.prepare('SELECT record_id FROM labels WHERE run_id = ?').all(keyedRun).some((l) => l.record_id === 'gh-token-prs:10')); } finally { kdb.close(); }
  writeFileSync(cfg, plain);

  // excerpts: off keeps the numbers and stores no PR title or body.
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^excerpts: on\b/m, 'excerpts: off'));
  const off = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(off.stdout).metrics.find((m) => m.name === 'merged'), run.metrics.find((m) => m.name === 'merged'));
  const prRecords = readFileSync(join(p, '.lfm', 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(prRecords.map((r) => r.source), Array(13).fill('prs'));
  assert.ok(prRecords.every((r) => !('text' in r)), 'PR text in records.jsonl with excerpts off');
  const db2 = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try {
    const texts = db2.prepare(`SELECT text FROM records WHERE source = 'prs' AND run_id = (SELECT max(id) FROM runs)`).all().map((x) => x.text);
    assert.deepEqual([texts.length, texts.filter(Boolean)], [13, []]);
  } finally { db2.close(); }

  const cfgFile = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(cfgFile, `${readFileSync(cfgFile, 'utf8')}causes:\n  rework:\n    description: "a merged PR needed rework"\n`);
  writeFileSync(join(p, '.lfm', 'labels.jsonl'), JSON.stringify({ id: 'prs:10', event: true, cause: 'rework', why: 'a PR that needed rework' }) + '\n');
  writeFileSync(join(p, '.lfm', 'proposals.jsonl'), JSON.stringify({ cause: 'rework', target: 'docs', owner: 'umer', change: 'add a check', refs: ['prs:10'] }) + '\n');
  const full = JSON.parse(lfm({}, 'report', '--full', '--json').stdout);
  assert.deepEqual(full.causes.find((c) => c.cause === 'rework').proposal_refs, ['prs:10']);
});

test('a window with no merged PR: merged is 0, the ratios and the sums are n/a', () => {
  const { tmp, p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  prs: { type: github }\n');
  writeFileSync(join(tmp, 'pages', 'first.json'), page([pr(2, 'feat: old work', { merged: 400 })], 'second'));
  const r = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(r.stdout);
  assert.deepEqual(run.sources, [{ id: 'prs', type: 'github', items: 0 }]);
  const names = ['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped'];
  const current = Object.fromEntries(run.metrics.filter((m) => names.includes(m.name)).map((m) => [m.name, m.current]));
  assert.deepEqual(current, { merged: 0, first_pass: 'n/a', p50_hours_to_merge: 'n/a', p90_hours_to_merge: 'n/a', rework_ci: 'n/a', rework_other: 'n/a', reverted: 'n/a', escaped: 'n/a' });
});

test('a missing or logged-out gh and a non-GitHub origin fail the source with the fix, never the origin URL', () => {
  const { p, bin, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  prs: { type: github }\n');
  const out = lfm({ FAKE_GH: 'logged-out' }, 'ingest');
  assert.equal(out.status, 2, out.stderr);
  assert.match(out.stderr, /^error: source prs: gh is not logged in to github\.com$/m);
  assert.match(out.stderr, /^next: remove sources\.prs from \.learn-from-mistakes\.yaml, or log in: gh auth login --hostname github\.com$/m);

  rmSync(join(bin, 'gh'));
  const missing = lfm({}, 'ingest');
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /^error: source prs: gh is not on PATH$/m);
  assert.deepEqual(JSON.parse(lfm({}, 'init', '--json').stdout).skipped, ['github: origin is on GitHub, but gh is not on PATH: install the GitHub CLI, then gh auth login']);

  const token = `umer:${'T'.repeat(20)}`;
  execFileSync('git', ['-C', p, 'remote', 'set-url', 'origin', `https://${token}@gitlab.example.com/umer/umer-app.git`]);
  const other = lfm({}, 'ingest');
  assert.equal(other.status, 2, other.stderr);
  assert.match(other.stderr, /^error: source prs: the project's git origin is not a GitHub repo$/m);
  assert.ok(!other.stderr.includes('T'.repeat(20)));
  rmSync(join(p, '.learn-from-mistakes.yaml'));
  const init = lfm({}, 'init', '--json'); // not on GitHub: no github source, and nothing skipped
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual([JSON.parse(init.stdout).sources, JSON.parse(init.stdout).skipped], [{}, []]);
});
