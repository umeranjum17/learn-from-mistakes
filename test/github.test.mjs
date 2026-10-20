// End-to-end: init and a retro with a github source in a throwaway git repo whose origin is on GitHub. PATH holds a fake
// gh that records its argv and answers with synthetic GraphQL pages written here, plus git and two fake agent CLIs; no
// call reaches GitHub. The pages give known first-pass, hours-to-merge, rework, revert and escape numbers in both windows,
// and repeat a PR across two pages, as a PR updated between the two reads would be.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parse } from 'yaml';
// The user's agents, set once in the throwaway global config: a run needs both and the tool never picks one.
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const FAKE_AGENT = new URL('fake-agent/claude', import.meta.url).pathname;
const SECRET = `gh${'p_'}${'Z'.repeat(36)}`; // built here, so no key-shaped string sits in the repo
const FAKE_GH = `
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.FAKE_LOG, 'gh.jsonl'), JSON.stringify(args) + '\\n');
if (process.env.FAKE_GH === 'logged-out') { console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4); }
if (args[0] === 'auth') { console.log('github.com: Logged in to github.com account umer'); process.exit(0); }
const rest = args.find((a) => a.startsWith('repos/'));
if (rest) { // the Actions runs and a run attempt's jobs, already cut down by gh's --jq
  const [, , , , , run, , attempt] = rest.split('?')[0].split('/'), file = path.join(process.env.FAKE_PAGES, run ? 'jobs-' + run + '-' + attempt + '.jsonl' : 'runs.jsonl');
  if (!fs.existsSync(file) || process.env.FAKE_GH === 'no-actions') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  process.stdout.write(fs.readFileSync(file)); process.exit(0);
}
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
  for (const name of ['claude', 'codex']) symlinkSync(FAKE_AGENT, join(bin, name)); // the worker and the judge, with node for their #! line
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
  // Actions runs: this window (CI 50% failed, one rerun that was flaky, one cancelled Deploy) and the last window (CI 50% failed).
  const jl = (rows) => rows.map((x) => JSON.stringify(x)).join('\n') + '\n';
  const run = (id, name, conclusion, hours, attempt = 1) => ({ id, name, conclusion, run_attempt: attempt, created_at: ago(hours) });
  writeFileSync(join(pages, 'runs.jsonl'), jl([run(101, 'CI', 'success', 10), run(102, 'CI', 'failure', 20), run(103, 'CI', 'success', 30, 2), run(104, 'Deploy', 'cancelled', 40),
    run(105, 'CI', 'failure', 50), run(106, 'CI', 'success', 200), run(107, 'CI', 'failure', 220)]));
  const job = (name, conclusion) => ({ name, conclusion });
  for (const [file, rows] of Object.entries({ '102-1': [job('lint', 'failure'), job('test', 'failure'), job('build', 'success')], '103-1': [job('test', 'failure'), job('lint', 'success')],
    '103-2': [job('test', 'success'), job('lint', 'success')], '105-1': [job('test', 'failure')], '107-1': [job('lint', 'failure')] })) writeFileSync(join(pages, `jobs-${file}.jsonl`), jl(rows));
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), FAKE_LOG: log, FAKE_PAGES: pages };
  mkdirSync(env.LFM_HOME, { recursive: true });
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), AGENTS_SET);
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
  const numbers = Object.fromEntries(run.metrics.filter((m) => !/^(defects|tool_error|corrections|interrupts|retries|cause_count:|gate_failures|decisions|blocks|steers|interventions|hours_|tasks_timed)/.test(m.name)).map((m) => [m.name, [m.current, m.previous]]));
  assert.deepEqual(numbers, {
    merged: [10, 3], first_pass: [77.8, 33.3], p50_hours_to_merge: [1, 5], p90_hours_to_merge: [5, 10],
    rework_ci: [1, 0], rework_other: [1, 0], rework_per_merge: [0.2, 0], reverted: [1, 1], escaped: [1, 1],
    ci_runs: [4, 2], ci_failure_rate: [50, 50], ci_reruns: [1, 0], ci_flaky_jobs: [1, 0], 'ci_failure_rate:umer/umer-app': [50, 50],
    'ci_job_failures:umer/umer-app / CI / lint': [1, 1], 'ci_job_failures:umer/umer-app / CI / test': [2, 0],
  });
  const text = readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'report.txt'), 'utf8');
  assert.match(text, /^- ci_failure_rate: this window 50, last window 50, trend flat, no target\.$/m);
  assert.match(text, /^- CI job umer\/umer-app \/ CI \/ test: failed 2 times this window, 0 last window, trend up\.$/m);
  assert.ok(text.indexOf('CI / test') < text.indexOf('CI / lint'), 'the job that fails most comes first');
  assert.ok(!/Actions runs/.test(text.split('6. Not checked')[1]), 'no gap line when the runs were read');
  const gql = calls().filter((c) => c[1] === 'graphql');
  assert.ok(calls().some((c) => c[1] === '--paginate' && c[2].startsWith('repos/umer/umer-app/actions/runs?')), 'the runs are listed through the REST API');
  assert.equal(gql.length, 2, 'the read stops at the first PR updated before the range');
  assert.deepEqual(gql[0].slice(0, 2), ['api', 'graphql']);
  assert.ok(gql[0].includes('owner=umer') && gql[0].includes('name=umer-app') && !gql[0].some((a) => a.startsWith('after=')));
  assert.ok(gql[1].includes('after=second'));
  assert.ok(!r.stdout.includes(SECRET) && !r.stderr.includes(SECRET));
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'bundle.md'), 'utf8');
  assert.match(bundle, /^- \[prs:10\] prs at PR #10, /m);
  assert.match(bundle, /^- \[prs:10\] prs at PR #10, .*\n  > .*Demo value: \[redacted\]/m); // the PR body's canary is in the bundle, redacted
  assert.ok(!bundle.includes(SECRET), 'the PR body token in bundle.md');
  const reported = lfm({}, 'report');
  assert.equal(reported.status, 0, reported.stderr);

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
    assert.deepEqual([texts.length, texts.filter(Boolean)], [20, []]); // 13 PRs and 7 Actions runs
  } finally { db2.close(); }

  const cfgFile = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(cfgFile, readFileSync(cfgFile, 'utf8').replace(/^causes:\n/m, 'causes:\n  rework:\n    description: "a merged PR needed rework"\n')); // beside init's starter causes
  const proposed = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'rework', FAKE_PROPOSE: 'twin' }, 'retro', '--foreground'); // one fix citing one PR
  assert.equal(proposed.status, 0, proposed.stderr);
  const full = JSON.parse(lfm({}, 'report', '--full', '--json').stdout); // a PR id is not content, so --full names it
  assert.match(full.causes.find((c) => c.cause === 'rework').proposal_refs.join(' '), /^prs:\d+$/);
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

test('Actions runs gh cannot read leave the CI numbers n/a, keep the PR numbers, and the report names the missing source', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  prs: { type: github }\n');
  const r = lfm({ FAKE_GH: 'no-actions' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(r.stdout), value = (name) => run.metrics.find((m) => m.name === name).current;
  assert.deepEqual([value('merged'), value('ci_runs'), value('ci_failure_rate')], [10, 'n/a', 'n/a']);
  assert.deepEqual(run.sources[0].missing, ['GitHub Actions runs of umer/umer-app (gh: Not Found (HTTP 404))']);
  assert.match(readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'report.txt'), 'utf8'), /^- Source prs gave no GitHub Actions runs of umer\/umer-app \(gh: Not Found \(HTTP 404\)\)\.$/m);
});

test('a missing or logged-out gh and a non-GitHub origin fail the source with the fix, never the origin URL', () => {
  const { p, bin, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  prs: { type: github }\n');
  const source = (env) => JSON.parse(lfm(env, 'doctor', '--json').stdout).checks.find((c) => c.label === 'source prs'); // its problem and fix
  const out = source({ FAKE_GH: 'logged-out' });
  assert.equal(out.detail, 'github: gh is not logged in to github.com');
  assert.match(out.fix, /^remove sources\.prs from .*\/umer-app\/\.learn-from-mistakes\.yaml, or log in: gh auth login --hostname github\.com$/);

  rmSync(join(bin, 'gh'));
  assert.equal(source({}).detail, 'github: gh is not on PATH');
  assert.deepEqual(JSON.parse(lfm({}, 'init', '--json').stdout).skipped, ['github: origin is on GitHub, but gh is not on PATH: install the GitHub CLI, then gh auth login']);

  const token = `umer:${'T'.repeat(20)}`;
  execFileSync('git', ['-C', p, 'remote', 'set-url', 'origin', `https://${token}@gitlab.example.com/umer/umer-app.git`]);
  const other = lfm({}, 'doctor', '--json');
  assert.equal(JSON.parse(other.stdout).checks.find((c) => c.label === 'source prs').detail, "github: the project's git origin is not a GitHub repo");
  assert.ok(!other.stdout.includes('T'.repeat(20)) && !other.stderr.includes('T'.repeat(20)));
  rmSync(join(p, '.learn-from-mistakes.yaml'));
  const init = lfm({}, 'init', '--json'); // not on GitHub: no github source, and nothing skipped
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual([JSON.parse(init.stdout).sources, JSON.parse(init.stdout).skipped], [{}, []]);
});

// A synthetic Firstmate home: 3 status files (one with CRLF ends) and 5 inbox messages (one acknowledged into handled/), a
// defect log and a targets file. Lines with no stamp take the one above; an entry with no time, a stamp that is not digits
// or one out of range is skipped.
test('init --firstmate <home> opts in; the retro counts its decisions, blocks and steers per merged PR, with its targets', () => {
  const { tmp, p, lfm } = setup();
  const home = join(tmp, 'umer-home'), at = (days) => `at=${Math.floor(NOW / 1000 - days * 86_400)}`;
  const put = (file, text) => { mkdirSync(join(home, file, '..'), { recursive: true }); writeFileSync(join(home, file), text); };
  put('state/alpha.status', `working [${at(2)}]: started\nneeds-decision [${at(1)}] [key=k1]: pick a name\nblocked: waiting on ${SECRET}\nresolved [${at(0.5)}] [key=k1]: named\n`);
  put('state/beta.status', `blocked [${at(10)}]: last window\nneeds-decision [${at(1)}]: merge order\n`);
  put('state/gamma.status', `needs-decision: no stamp above\r\nworking [${at(1)}]: ok\r\nblocked [at=<epoch>]: a stamp that is not digits\r\n`);
  put('state/alpha.inbox/002.msg', `${at(1)}\n[${SECRET}] rename the page\n`);
  put('state/alpha.inbox/handled/001.msg', `${at(2)}\n[steer] use the demo data\n`);
  put('state/beta.inbox/001.msg', `${at(9)}\n[answer] yes\n`);
  put('state/gamma.inbox/001.msg', '[steer] no time\n');
  put('state/gamma.inbox/002.msg', 'at=99999999999999\n[steer] out of range\n');
  put('data/defects.md', `## ${new Date(NOW - 86_400_000).toISOString().slice(0, 10)}\n\n- [tests] Umer's demo flake.\n`);
  put('config/targets.tsv', 'metric\top\ttarget\towner\trule\nblocks\t<=\t0\tUmer\tR1\nfirst_pass\t>=\t80\tUmer\tR2\n');
  assert.equal(lfm({}, 'init', '-y', '--no-skill', '--firstmate', join(tmp, 'none')).status, 2);
  assert.equal(lfm({}, 'init', '-y', '--no-skill').status, 0); // an existing config: --firstmate adds the source to it
  const init = lfm({}, 'init', '-y', '--no-skill', '--firstmate', home, '--json');
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).sources, { prs: { type: 'github' }, home: { type: 'firstmate', path: home } });
  assert.match(lfm({}, 'doctor').stdout, /4 skipped \(no time\)/);
  const r = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(SECRET));
  const m = Object.fromEntries(JSON.parse(r.stdout).metrics.map((x) => [x.name, [x.current, x.previous, x.target, x.met]]));
  assert.deepEqual([m.decisions, m.blocks, m.steers, m.interventions_per_merge, m.first_pass, m.defects], [[2, 0, '', ''], [1, 1, '<= 0', 'missed'],
    [2, 1, '', ''], [0.5, 0.667, '', ''], [77.8, 33.3, '>= 80', 'missed'], [1, 0, '', '']]);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try { assert.ok(db.prepare(`SELECT text, data FROM records WHERE source = 'home'`).all().every((x) => !x.text.includes(SECRET) && !x.data.includes(SECRET))); } finally { db.close(); }
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'name: umer-app\nsources:\n'); // a config whose sources key is empty: the opt-in still adds home
  const bare = lfm({}, 'init', '-y', '--no-skill', '--firstmate', home, '--json');
  assert.equal(bare.status, 0, bare.stderr);
});

test('a registry summary with parentheses still reads its home', () => {
  const { tmp, lfm } = setup();
  const [main, mate] = ['harbor-main', 'ops-mate'].map((n) => join(tmp, n));
  const at = Math.floor(NOW / 1000 - 86_400);
  mkdirSync(join(main, 'data'), { recursive: true });
  mkdirSync(join(main, 'state'), { recursive: true });
  writeFileSync(join(main, 'data', 'secondmates.md'), `# Secondmates\n\n- ops - deploys (staging) (home: ${mate}; scope: demo; added 2026-10-01) (see ops)\n`);
  mkdirSync(join(mate, 'state'), { recursive: true });
  writeFileSync(join(mate, 'state', 'task.status'), `needs-decision [at=${at}]: pick a region\n`);
  assert.equal(lfm({}, 'init', '-y', '--no-skill', '--firstmate', main, '--fleet', '--json').status, 0);
  assert.match(lfm({}, 'doctor').stdout, /2 homes, 0 registry lines skipped \(no local home\), 1 decisions/);
});

test('init refuses a fleet whose registry lists the main home, and leaves the config unchanged', () => {
  const { tmp, p, lfm } = setup();
  const main = join(tmp, 'harbor-main');
  mkdirSync(join(main, 'data'), { recursive: true });
  writeFileSync(join(main, 'data', 'secondmates.md'), `- mate - x (home: ${main}; scope: demo; added 2026-10-01)\n`);
  const cfg = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(cfg, 'name: umer-app\nsources:\n');
  const before = readFileSync(cfg, 'utf8');
  const init = lfm({}, 'init', '-y', '--no-skill', '--firstmate', main, '--fleet');
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /^error: \S+: sources\.home reads \S+ twice$/m);
  assert.equal(readFileSync(cfg, 'utf8'), before);
});

// A synthetic fleet: a main home and two secondmate homes its registry lists, plus a remote route and a line with no home,
// which are skipped and counted. Two homes hold a status file of the same name. No home's name or path reaches the bundle
// or a prompt; the report gives each home's counts by its salted id, and a home that cannot be read fails the retro.
test('init --firstmate <home> --fleet reads every home of the fleet; home names stay out of the bundle and prompts', () => {
  const { tmp, p, lfm } = setup();
  const [main, kestrel, wren, late, far2] = ['harbor-main', 'kestrel-mate', 'wren-mate', 'late-mate', 'far2-mate'].map((n) => join(tmp, n));
  const tilde = join(tmp, 'home', 'fm-tilde');
  const at = (days) => `at=${Math.floor(NOW / 1000 - days * 86_400)}`;
  const put = (home, file, text) => { mkdirSync(join(home, file, '..'), { recursive: true }); writeFileSync(join(home, file), text); };
  const registry = (...homes) => put(main, 'data/secondmates.md', `# Secondmates\n\n${homes.map((h, i) => `- mate${i} - Umer's work (home: ${h}; scope: demo; projects: umer-app; last-seen: 2026-10-01; retired; added 2026-10-01)\n`).join('')}`
    + '- far - a remote route (host: far-box; root: /srv/fm; home: /srv/fm-home; scope: demo; projects: umer-app; added 2026-10-01)\n- loose - a line with no home field\n'
    + `- late - a home after its other keys (scope: demo; home: ${late}; added 2026-10-01)\n- tilde - a home under ~ (scope: demo; home: ~/fm-tilde; added 2026-10-01)\n`
    + `- far2 - a remote route with home before host (home: ${far2}; host: far-box; scope: demo)\n`);
  put(main, 'state/task.status', `blocked [${at(1)}]: waiting on review\n`);
  put(kestrel, 'state/task.status', `needs-decision [${at(1)}]: pick a name\nblocked [${at(2)}]: waiting on CI\n`);
  put(wren, 'state/demo.inbox/001.msg', `${at(1)}\n[steer] use the demo data\n`);
  put(wren, 'data/defects.md', `## ${new Date(NOW - 86_400_000).toISOString().slice(0, 10)}\n\n- [tests] Umer's demo flake.\n`);
  put(late, 'state/task.status', `needs-decision [${at(1)}]: a home after its other keys\n`);
  put(tilde, 'state/task.status', `blocked [${at(1)}]: a home under ~\n`);
  put(far2, 'state/task.status', `needs-decision [${at(1)}]: a remote route is not read\n`);
  registry(kestrel, wren);
  assert.equal(lfm({}, 'init', '-y', '--no-skill', '--fleet').status, 2); // --fleet needs --firstmate
  const init = lfm({}, 'init', '-y', '--no-skill', '--firstmate', main, '--fleet', '--json');
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).sources.home, { type: 'firstmate', path: main, fleet: true });
  assert.match(lfm({}, 'doctor').stdout, /5 homes, 3 registry lines skipped \(no local home\), 2 decisions, 3 blocks, 1 steers, 1 defect records/);
  const r = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(r.stdout);
  const m = Object.fromEntries(run.metrics.map((x) => [x.name, x.current]));
  assert.deepEqual([m.decisions, m.blocks, m.steers, m.defects], [2, 3, 1, 1]); // the fleet totals
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  let salt, refs;
  try {
    salt = db.prepare('SELECT salt FROM secret').get().salt;
    refs = db.prepare(`SELECT record_id, ref FROM records WHERE source = 'home'`).all();
  } finally { db.close(); }
  const id = (home) => createHmac('sha256', salt).update(home).digest('hex').slice(0, 12);
  assert.ok(refs.some((x) => x.record_id === `${id(main)}/task.status:1`) && refs.some((x) => x.record_id === `${id(kestrel)}/task.status:1`)); // same file, two homes
  assert.ok(refs.some((x) => x.ref.startsWith(join(kestrel, 'state'))), 'the store keeps the real path');
  const dir = join(p, '.lfm', 'runs', String(run.run.id)), bundle = readFileSync(join(dir, 'bundle.md'), 'utf8');
  assert.match(bundle, new RegExp(`^- \\[${id(wren)}/defects:\\w+\\] home in home ${id(wren)}, `, 'm'));
  const prompts = ['claude', 'codex'].flatMap((a) => readFileSync(join(tmp, 'log', `${a}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l).stdin));
  assert.ok(prompts.some((x) => x.includes(bundle)), 'bundle not delivered to an agent');
  for (const text of [bundle, ...prompts]) for (const canary of ['harbor-main', 'kestrel-mate', 'wren-mate', 'mate0', tmp]) assert.ok(!text.includes(canary), `${canary} reached the bundle or a prompt`);
  const report = readFileSync(join(dir, 'report.txt'), 'utf8');
  for (const line of [`- Home ${id(main)}: 0 decisions, 1 block, 0 steers, 0 defects this window.`, `- Home ${id(kestrel)}: 1 decision, 1 block, 0 steers, 0 defects this window.`,
    `- Home ${id(wren)}: 0 decisions, 0 blocks, 1 steer, 1 defect this window.`, `- Home ${id(late)}: 1 decision, 0 blocks, 0 steers, 0 defects this window.`,
    `- Home ${id(tilde)}: 0 decisions, 1 block, 0 steers, 0 defects this window.`, '- Source home skipped 3 home lines with no local home.']) assert.ok(report.includes(line), `report.txt lacks ${line}`);
  registry(kestrel, join(tmp, 'gone-mate')); // a listed home that cannot be read fails the retro, naming the source and the fix
  const gone = lfm({}, 'retro', '--foreground');
  assert.notEqual(gone.status, 0);
  assert.match(gone.stderr, /^error: collect: source home: cannot read \S*gone-mate\/state \(ENOENT\)/m);
  assert.match(gone.stderr, /^next: learn-from-mistakes-axi rerun --resume --run \d+   # finish it after fixing source home in the collect step/m);
  assert.match(lfm({}, 'doctor').stdout, /fix or remove the line of \S*gone-mate in \S*secondmates\.md, the fleet registry source home reads/); // doctor names the registry line
  registry(kestrel, wren, kestrel); // a home listed twice fails the config, before any read
  const twice = lfm({}, 'retro', '--foreground');
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /^error: \S+: sources\.home reads \S+ twice$/m);
  assert.match(twice.stderr, /^next: fix or remove the line of \S+ in \S*secondmates\.md'?, line \d+$/m);
  assert.match(lfm({}, 'doctor').stdout, /^fail config\s+\S+: sources\.home reads \S+ twice$/m);
  registry(kestrel, wren);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `name: umer-app\nsources:\n  home: { type: firstmate, path: ${main}, fleet: true }\n  kestrel: { type: firstmate, path: ${kestrel} }\n`);
  const cross = lfm({}, 'retro', '--foreground');
  assert.notEqual(cross.status, 0);
  assert.match(cross.stderr, /^error: \S+: sources\.home and sources\.kestrel both read \S+$/m);
  assert.match(cross.stderr, /^next: remove \S+ from source home or source kestrel$/m);
  assert.match(lfm({}, 'doctor').stdout, /fix: edit \S+\s+# then run doctor again/);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `name: umer-app\nsources:\n  home: { type: firstmate, path: ${main}, fleet: true }\n`);
  const empty = join(tmp, 'empty-mate');
  mkdirSync(empty);
  registry(kestrel, wren, empty); // a listed home whose folder exists with no state/ reads as empty
  const quiet = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(quiet.status, 0, quiet.stderr);
  const quietReport = readFileSync(join(p, '.lfm', 'runs', String(JSON.parse(quiet.stdout).run.id), 'report.txt'), 'utf8');
  assert.ok(quietReport.includes(`- Home ${id(empty)}: 0 decisions, 0 blocks, 0 steers, 0 defects this window.`));
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'name: umer-app\nsources:\n');
  const solo = join(tmp, 'solo-main');
  put(solo, 'state/task.status', `blocked [${at(1)}]: a fleet of one\n`);
  const soloInit = lfm({}, 'init', '-y', '--no-skill', '--firstmate', solo, '--fleet', '--json');
  assert.equal(soloInit.status, 0, soloInit.stderr);
  assert.match(lfm({}, 'doctor').stdout, /1 homes, 0 registry lines skipped \(no local home\)/);
  const soloRun = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(soloRun.status, 0, soloRun.stderr);
  const soloReport = readFileSync(join(p, '.lfm', 'runs', String(JSON.parse(soloRun.stdout).run.id), 'report.txt'), 'utf8');
  assert.ok(soloReport.includes(`- Home ${id(solo)}: 0 decisions, 1 block, 0 steers, 0 defects this window.`));
});

// A Firstmate home with data/metrics tables and no github source: the PR metrics come from prs.tsv, steers and corrections
// from daily.tsv (the inbox messages are not added on top), and with no daily.tsv the steers come from the handled
// messages, timed by the epoch their file name starts with. Entries that vanish mid-walk are skipped, and a folder that
// cannot be read is named by its path.
test('a firstmate home reads data/metrics/prs.tsv and daily.tsv, counts steers from them or from handled inboxes, and names an unreadable path', () => {
  const { tmp, p, lfm } = setup();
  const home = join(tmp, 'umer-home'), day = (days) => new Date(NOW - days * 86_400_000).toISOString(), at = (days) => `at=${Math.floor(NOW / 1000 - days * 86_400)}`;
  const put = (file, text) => { mkdirSync(join(home, file, '..'), { recursive: true }); writeFileSync(join(home, file), text); };
  const prHead = 'home\trepo\tpr\tcreated\tmerged\thours_to_merge\tbuild_hours\tcommits\tcommits_after_open\trework_ci\trework_pipeline\trework_other\treverted\tescaped\tfirst_pass\tbot\ttitle';
  const prRow = (days, hours, { other = 0, escaped = 0, bot = '', first = 1 } = {}) => `umer\tdemo\t1\t${day(days + 1)}\t${day(days)}\t${hours}\t0\t1\t${other}\t0\t0\t${other}\t0\t${escaped}\t${first}\t${bot}\tUmer's demo page`;
  put('data/metrics/prs.tsv', [prHead, prRow(2, 2), prRow(3, 4, { other: 1, first: 0 }), prRow(1, 1, { escaped: 1, first: 0 }), prRow(1, 0.5, { bot: 1 }),
    prRow(9, 8), prRow(4, 1).replace(day(4), 'not-a-time')].join('\n') + '\n'); // the last row has no merge time: skipped
  const dayOf = (days) => day(days).slice(0, 10);
  put('data/metrics/daily.tsv', ['day\thome\tsteers\ts_correct', `${dayOf(1)}\tdemo\t5\t2`, `${dayOf(1)}\tother\t7\t1`, `${dayOf(5)}\tdemo\t0\t0`, `${dayOf(9)}\tdemo\t3\t1`].join('\n') + '\n');
  put('state/alpha.status', `needs-decision [${at(1)}]: pick a name\n`);
  put(`state/alpha.inbox/handled/${Math.floor(NOW / 1000 - 86_400)}-ab12.msg`, '[steer] use the demo data\n'); // no at= line: the file name times it
  put(`state/alpha.inbox/${Math.floor(NOW / 1000 - 2 * 86_400)}-cd34.msg`, '[steer] rename it\n');
  put('state/.fm-lease-command.lock.owner.1/pid', '1\n'); // a lock folder: never entered
  symlinkSync(join(tmp, 'nowhere'), join(home, 'state', 'gone.status')); // listed, then gone when read
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `name: umer-app\nsources:\n  home: { type: firstmate, path: ${home} }\n`);
  const doctor = lfm({}, 'doctor').stdout;
  assert.match(doctor, /^ok\s+source home\s+firstmate: 1 decisions, 0 blocks, 15 steers, 0 defect records, 5 merged PRs and 4 daily rows in data\/metrics, 1 skipped \(no time\)$/m);
  const metricsOf = () => {
    const r = lfm({}, 'retro', '--foreground', '--json');
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(JSON.parse(r.stdout).metrics.map((x) => [x.name, [x.current, x.previous, x.target, x.met]]));
  };
  let m = metricsOf();
  assert.deepEqual([m.merged, m.first_pass, m.p50_hours_to_merge, m.p90_hours_to_merge, m.rework_ci, m.rework_other, m.reverted, m.escaped],
    [[4, 1, '', ''], [33.3, 100, '>= 70', 'missed'], [1, 8, '', ''], [4, 8, '<= 8', 'met'], [0, 0, '', ''], [1, 0, '', ''], [0, 0, '', ''], [1, 0, '<= 0', 'missed']]);
  assert.deepEqual([m.steers, m.corrections_per_session, m.interventions_per_merge], [[12, 3, '', ''], [0.75, 1, '<= 0.3', 'missed'], [3.25, 3, '', '']]);
  assert.deepEqual([m.rework_per_merge, m.corrections_per_merge], [[0.25, 0, '', ''], [0.75, 1, '', '']]);
  unlinkSync(join(home, 'data', 'metrics', 'daily.tsv')); // no daily table: the two handled and pending messages are the steers
  m = metricsOf();
  assert.deepEqual([m.steers, m.corrections_per_session, m.merged], [[2, 0, '', ''], ['n/a', 'n/a', '<= 0.3', 'n/a'], [4, 1, '', '']]);
  assert.equal(m.corrections_per_merge[0], 'n/a');
  const gone = JSON.parse(lfm({}, 'retro', '--foreground', '--json').stdout); // the report names the table that is missing
  assert.deepEqual(gone.sources[0].missing, ['rows in daily.tsv under data/metrics of the home']);
  if (process.getuid?.() !== 0) { // a folder that cannot be read is no vanished entry: the error names its path
    const locked = join(home, 'state', 'locked.inbox');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try { assert.match(lfm({}, 'doctor').stdout, /^fail\s+source home\s+firstmate: cannot read \S+\/state\/locked\.inbox \(EACCES\)/m); } finally { chmodSync(locked, 0o755); }
  }
});

// A markdown-log whose bullets carry no date can never be placed in a window: doctor warns, naming the source, and the
// report's not-checked section says so.
test('a markdown-log source with no dated record is named by doctor and by the report', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, 'gate.md'), '# Gate report\n\n- [tests] A demo flake.\n- [lint] Umer\'s lint failure.\n');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'name: umer-app\nsources:\n  gate: { type: markdown-log, path: gate.md }\n');
  assert.match(lfm({}, 'doctor').stdout, /^warn\s+source gate\s+markdown-log: 2 records, 0 in the window, 2 skipped \(no date\): source gate has 2 records and none has a date, so the retro window places none of them/m);
  const r = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(p, '.lfm', 'runs', String(JSON.parse(r.stdout).run.id), 'report.txt'), 'utf8'), /^- Source gate read 2 records and none has a date, so the window placed none of them\./m);
});

// Where the time goes: a Firstmate home's status lines give each task's stages (a line's stage lasts until the next line's
// stamp), so the retro prints hours a stage and ranks the three longest waits with their cause and fix. A task still open
// adds no stage for its last line, a line with no stamp adds none, and prs.tsv gives the merge wait when the home has it.
test('a firstmate home times the stages of its tasks and the report names the three slowest waits', () => {
  const { tmp, p, lfm } = setup();
  const home = join(tmp, 'umer-home'), hoursAgo = (h) => `at=${Math.floor(NOW / 1000 - h * 3600)}`;
  const put = (file, text) => { mkdirSync(join(home, file, '..'), { recursive: true }); writeFileSync(join(home, file), text); };
  put('state/alpha.status', [`working [${hoursAgo(30)}]: start`, `needs-decision [${hoursAgo(28)}]: pick a name`, `working [${hoursAgo(24)}]: name picked`,
    `paused [${hoursAgo(20)}]: waiting on the pipeline checks`, `working [${hoursAgo(17)}]: checks green`, `blocked [${hoursAgo(16)}]: waiting for review round 1`,
    `working [${hoursAgo(13)}]: review fixed`, `done [${hoursAgo(10)}]: PR open`].join('\n') + '\n');
  put('state/beta.status', [`queued [${hoursAgo(40)}]: waiting for a slot`, `working [${hoursAgo(36)}]: start`, `blocked [${hoursAgo(34)}]: waiting on the tool host`,
    `resolved [${hoursAgo(33)}]: host back`, 'working: a line with no stamp', `working [${hoursAgo(31)}]: still on it`].join('\n') + '\n');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `name: umer-app\nsources:\n  home: { type: firstmate, path: ${home} }\n`);
  const retro = () => {
    const r = lfm({}, 'retro', '--foreground', '--json');
    assert.equal(r.status, 0, r.stderr);
    const run = JSON.parse(r.stdout);
    return { metrics: Object.fromEntries(run.metrics.map((x) => [x.name, x.current])), report: readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'report.txt'), 'utf8') };
  };
  const stages = ['hours_working', 'hours_queued', 'hours_waiting_captain', 'hours_waiting_ci', 'hours_in_review', 'hours_blocked', 'hours_merge_wait', 'tasks_timed'];
  let { metrics, report } = retro();
  assert.deepEqual(stages.map((n) => metrics[n]), [14, 4, 4, 3, 3, 1, 0, 2]);
  assert.match(report, /^- Where the time goes: 14 hours of work and 15 hours of waiting, over 2 tasks\.$/m);
  assert.match(report, /^- Slowest wait 1, queued before a worker started: 4 hours, 27% of the waiting\.\n {3}Cause: .+\n {3}Fix: .+\n- Slowest wait 2, waiting for the captain: 4 hours, 27% of the waiting\.\n/m);
  assert.match(report, /^- Slowest wait 3, waiting for CI: 3 hours, 20% of the waiting\.$/m);
  assert.doesNotMatch(report, /Slowest wait 4/);

  const day = (h) => new Date(NOW - h * 3_600_000).toISOString();
  const row = (hours) => `umer\tdemo\t1\t${day(hours + 5)}\t${day(hours)}\t${hours}\t0\t1\t0\t0\t0\t0\t0\t0\t1\t\tUmer's demo page`;
  put('data/metrics/prs.tsv', ['home\trepo\tpr\tcreated\tmerged\thours_to_merge\tbuild_hours\tcommits\tcommits_after_open\trework_ci\trework_pipeline\trework_other\treverted\tescaped\tfirst_pass\tbot\ttitle', row(2), row(4)].join('\n') + '\n');
  ({ metrics, report } = retro());
  assert.deepEqual([metrics.hours_merge_wait, metrics.hours_working], [6, 14]); // the PRs' open hours are the merge wait
  assert.match(report, /^- Where the time goes: 14 hours of work and 21 hours of waiting, over 2 tasks\.$/m);
  assert.match(report, /^- Slowest wait 1, with the PR open until merged: 6 hours, 29% of the waiting\.$/m);
});

test('a firstmate home whose tasks have one status line has no stage numbers and no time section', () => {
  const { tmp, p, lfm } = setup();
  const home = join(tmp, 'umer-home');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'alpha.status'), `needs-decision [at=${Math.floor(NOW / 1000 - 3600)}]: pick a name\nworking: no stamp\n`); // a stamped open task and a line with no stamp time nothing
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `name: umer-app\nsources:\n  home: { type: firstmate, path: ${home} }\n`);
  const r = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const run = JSON.parse(r.stdout);
  assert.deepEqual(run.metrics.filter((m) => /^(hours_|tasks_)/.test(m.name)).map((m) => m.current), Array(8).fill('n/a'));
  assert.doesNotMatch(readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'report.txt'), 'utf8'), /Where the time goes|Slowest wait/);
});
