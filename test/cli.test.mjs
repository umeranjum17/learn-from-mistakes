// End-to-end: runs the real CLI on copies of the synthetic examples (state in the copy's .lfm/) with a throwaway LFM_HOME.
// The report is the privacy-bounded lfm-report.v2 (identifiers, counts and verdict words, never prose); lfm-changes.v1
// carries only the owner-written what/why of each applied change.
// LFM_CLI points the same journeys at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';
import { saltedId } from '../src/sources/markdown-log.mjs';
// The user's agents, set once in the throwaway global config: a run needs both and the tool never picks one.
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const CANARY = 'CANARY-private-prose-9f3a7c';
const FAKE_AGENT = new URL('fake-agent/claude', import.meta.url).pathname;
const MODELS = { claude: ['claude-haiku-5-5'] };
// git never looks above the temp dir, so a project that is not a git checkout is not read as part of the repo the
// temp dir happens to sit in (the gate source matches this project's checkout).
process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
// The example gate store's one repo is the copy: the no-mistakes source reads only this project's rows.
function own(p) {
  const db = new DatabaseSync(join(p, 'gate.sqlite'));
  try { db.prepare('UPDATE repos SET working_path = ?').run(realpathSync(p)); } finally { db.close(); }
}
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-'));
  after(() => rmSync(tmp, { recursive: true }));
  cpSync(new URL('../examples', import.meta.url).pathname, join(tmp, 'p'), { recursive: true });
  own(join(tmp, 'p'));
  // The fake agent as the worker and the judge, ahead of the host PATH: no test reaches a real agent CLI.
  const fakes = join(tmp, 'fakes'), user = join(tmp, 'user');
  mkdirSync(fakes);
  mkdirSync(user);
  for (const name of ['claude', 'codex']) symlinkSync(FAKE_AGENT, join(fakes, name));
  // Private HOME / SIGN_OFF_HOME / LFM_TEST_BOARD_ROOT: a host sign-off-axi never sees the owner's board.
  const env = { ...process.env, PATH: `${fakes}${delimiter}${process.env.PATH}`, LFM_HOME: join(tmp, 'home'),
    HOME: user, SIGN_OFF_HOME: user, TMPDIR: tmp, LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: tmp };
  mkdirSync(env.LFM_HOME);
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), AGENTS_SET);
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', join(tmp, 'p')], { encoding: 'utf8', env });
  const raw = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env });
  return { p: join(tmp, 'p'), tmp, lfm, raw, env };
}
// The TOON report's last stdout line is the `repeated:` summary, outside lfm-report.v2.
const summaryOf = (stdout) => stdout.trimEnd().split('\n').at(-1);
const toonBodyOf = (stdout) => { const lines = stdout.trimEnd().split('\n'); lines.pop(); return lines.join('\n') + '\n'; };
// A `status --json` read can lose one invocation while a worker starts: the store is busy mid-migration, or a spawn is
// lost under load, and the empty stdout would otherwise reach JSON.parse in a poll. Read again until it parses, bounded,
// so the wait is the read itself - never a fixed sleep - and a lost read is a retry, not a thrown parse error. The last
// read's own error is rethrown once the tries are spent.
async function statusJson(read, tries = 200) {
  for (let i = 0; ; i++) {
    let err;
    try { return JSON.parse(read().stdout); } catch (e) { err = e; }
    if (i >= tries) throw err;
    await new Promise((r) => setTimeout(r, 100));
  }
}
// Await a promise, but never forever. A child event that never comes - a 'close' whose stdio pipe a detached
// process keeps open, or a spawn lost under load - would otherwise leave the promise pending with nothing to
// settle it, and the file's event loop then drains and the multi-file runner cancels every running file with
// "Promise resolution is still pending but the event loop has already resolved". On the deadline the wait fails
// with what the caller can see, so the file always finishes.
async function deadline(promise, ms, onTimeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(onTimeout())), ms); })]); }
  finally { clearTimeout(timer); }
}

test('state lives in the project\'s own .lfm/, git-ignored by the tool, never in a commit', () => {
  const { p, lfm } = setup();
  const git = (...args) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=umer', '-c', 'user.email=umer@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one');
  const ref = git('rev-parse', 'HEAD').trim(); // in a git project only a ref that names a commit records
  const lfmDir = join(p, '.lfm');
  const change = lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', ref); // a ledger write on a fresh project
  assert.equal(change.status, 0, change.stderr);
  assert.equal(readFileSync(join(lfmDir, '.gitignore'), 'utf8'), '*\n');
  const retro = lfm('retro', '--foreground');
  assert.equal(retro.status, 0, retro.stderr);
  assert.match(readFileSync(join(lfmDir, 'records.jsonl'), 'utf8'), /"text":/); // full record text, so it must stay out of git
  assert.ok(existsSync(join(lfmDir, 'lfm.sqlite')));
  const status = git('status', '--porcelain', '--untracked-files=all');
  assert.doesNotMatch(status, /\.lfm/, status);
  assert.match(status, /\?\? defects\.md/); // the project's own files still show: only .lfm is ignored
  assert.match(git('status', '--porcelain', '--ignored'), /^!! \.lfm\/$/m); // ignored, not merely absent
  assert.ok(!existsSync(join(p, '.gitignore')), 'the project\'s own .gitignore is never touched');

  const { p: q, lfm: lfmQ } = setup(); // a deficient owner .gitignore refuses every write, before any state
  const mine = Buffer.from('# mine\n!keep.md\n*.jsonl\n');
  mkdirSync(join(q, '.lfm'));
  writeFileSync(join(q, '.lfm', '.gitignore'), mine);
  for (const args of [['change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234']]) {
    const r = lfmQ(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\.gitignore: does not ignore all of \.lfm, so state could be committed; make it contain the line \*/);
    assert.match(r.stderr, /^next: echo '\*' >> <project>\/\.lfm\/\.gitignore   # ignore all of \.lfm, and delete any line starting with !$/m);
  }
  assert.ok(readFileSync(join(q, '.lfm', '.gitignore')).equals(mine));
  assert.deepEqual(readdirSync(join(q, '.lfm')), ['.gitignore']);

  for (const owned of ['*\n', '# mine\n*\n']) { // an owner file that ignores everything is accepted byte-identical
    rmSync(join(q, '.lfm'), { recursive: true });
    mkdirSync(join(q, '.lfm'));
    writeFileSync(join(q, '.lfm', '.gitignore'), owned);
    assert.equal(lfmQ('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234').status, 0);
    assert.equal(readFileSync(join(q, '.lfm', '.gitignore'), 'utf8'), owned);
    assert.ok(existsSync(join(q, '.lfm', 'changes.jsonl')));
  }

  rmSync(join(q, '.lfm'), { recursive: true }); // '*' un-ignored back is still committable, so refused
  mkdirSync(join(q, '.lfm'));
  const negated = Buffer.from('*\n!records.jsonl\n');
  writeFileSync(join(q, '.lfm', '.gitignore'), negated);
  for (const args of [['change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234']]) {
    const r = lfmQ(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\.gitignore: does not ignore all of \.lfm, so state could be committed; make it contain the line \*/);
  }
  assert.ok(readFileSync(join(q, '.lfm', '.gitignore')).equals(negated));
  assert.deepEqual(readdirSync(join(q, '.lfm')), ['.gitignore']);

  rmSync(join(q, '.lfm'), { recursive: true }); // a .gitignore git would not read stops every write, before any state
  mkdirSync(join(q, '.lfm', '.gitignore'), { recursive: true });
  for (const args of [['change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234']]) {
    const r = lfmQ(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\.gitignore: not a regular file, so git would not ignore the state/);
    assert.match(r.stderr, /^next: rm -r <project>\/\.lfm\/\.gitignore   # the tool then writes one that ignores all of \.lfm$/m);
  }
  assert.deepEqual(readdirSync(join(q, '.lfm')), ['.gitignore']);
  rmSync(join(q, '.lfm'), { recursive: true });
  writeFileSync(join(q, '.lfm'), 'a stray file'); // a non-directory .lfm is a usage error, never a stack trace
  const stray = lfmQ('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(stray.status, 2, stray.stderr);
  assert.match(stray.stderr, /\.lfm: cannot create the state dir \(EEXIST\)/);
  assert.match(stray.stderr, /^next: mv <project>\/\.lfm <elsewhere>   # free \.lfm for the state dir/m);
  assert.doesNotMatch(stray.stderr, /\n\s+at /);
});

test('help, guide and version work without a project file', () => {
  const { raw } = setup();
  const h = raw('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /usage: learn-from-mistakes-axi/);
  assert.doesNotMatch(h.stdout, /\bingest\b|^  count |--labels|--proposals/m);
  assert.match(h.stdout, /next: learn-from-mistakes-axi guide/);
  const g = raw('guide'); // the agent procedure lives in the CLI, not in the installed skill
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /npx -y learn-from-mistakes-axi init.*doctor.*retro --wait 8m.*attach.*report\.txt.*sign-off's skill/s);
  assert.doesNotMatch(g.stdout, /\bingest\b|labels\.jsonl|proposals\.jsonl|claude-|gpt-/);
  assert.match(g.stdout.trim().split('\n').at(-1), /^next: learn-from-mistakes-axi doctor/);
  // every help and guide line fits a 100-column terminal, and names no internal word
  for (const r of [h, g]) {
    assert.ok(r.stdout.split('\n').every((l) => l.length <= 100), `a line is over 100 characters:\n${r.stdout.split('\n').find((l) => l.length > 100)}`);
    assert.doesNotMatch(r.stdout, /\bTOON\b|workerBin|judgeBin/);
  }
  // in the next: block, a wrapped comment's continuation is still a comment, never a bare command
  const nextBlock = h.stdout.split('\n').slice(h.stdout.split('\n').findIndex((l) => l.startsWith('next:')));
  for (const l of nextBlock) {
    if (l && !l.startsWith('next:')) assert.match(l, /^ +# /, `a next: continuation is not a comment: ${l}`);
  }
  const bare = raw(); // no config: point the agent at init
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /no \.learn-from-mistakes\.yaml/);
  assert.match(bare.stderr, /next: learn-from-mistakes-axi init/);
  const v = raw('--version');
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+(?:-[\w.]+)?(?: \(pre-release(?:, from source)?\))?$/);
  assert.equal(h.stdout.split('\n')[0], `learn-from-mistakes-axi ${v.stdout.trim()}`); // the help header names the running version
  assert.equal(raw('frobnicate').status, 2); // an unknown command is still a usage error
});

test('report is lfm-report.v2 for the last run in TOON and JSON with one summary line; with no run it exits 3', () => {
  const { p, lfm } = setup();
  for (const r of [lfm(), lfm('report')]) { // nothing to read yet
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /^next: learn-from-mistakes-axi retro --wait 8m   # /m);
  }
  const retro = lfm('retro', '--foreground', '--json');
  assert.equal(retro.status, 0, retro.stderr);
  const { run } = JSON.parse(retro.stdout);
  const bare = lfm('report');
  assert.equal(bare.status, 0, bare.stderr);
  const toon = decode(toonBodyOf(bare.stdout)); // invalid TOON throws; the summary line is outside the report
  assert.deepEqual([toon.schema, toon.run, toon.report_txt], ['lfm-report.v2', run.id, join(p, '.lfm', 'runs', String(run.id), 'report.txt')]);
  assert.equal(summaryOf(bare.stdout), 'repeated: agent-exit-wait (4 times/3 days)');
  assert.deepEqual(toon.repeated, [{ cause: 'agent-exit-wait', count: 4, days: 3 }]); // the summary's one count, the report's section 4
  assert.match(bare.stderr, new RegExp(`^next: learn-from-mistakes-axi status --run ${run.id}   # the run and its steps`, 'm'));
  const json = lfm('report', '--json');
  const model = JSON.parse(json.stdout); // no summary line in JSON
  // generated_at is each report's own time, so two reports never match on it; the rest is one projection.
  assert.deepEqual({ ...toon, generated_at: model.generated_at }, model);
  const gate = model.causes.find((c) => c.cause === 'agent-exit-wait');
  assert.deepEqual([gate.store.rows, gate.log.incidents, gate.repeated], [4, 0, true]); // typed store rows matched, never added to log
  assert.deepEqual(model.coverage, { labelled: 0, total_records: 18, unlabelled: 18 }); // this worker labelled nothing
  // --full adds only non-content ids: a gate row id, never record text or a content-hash record id.
  const full = JSON.parse(lfm('report', '--full', '--json').stdout);
  assert.ok(full.causes.find((c) => c.cause === 'agent-exit-wait').store_row_ids.includes('gate:step-1'));
  assert.doesNotMatch(JSON.stringify(full), /memory killer stopped|1b35bb2034fa|"why"|"change"|"description"|"branch"/i);
});

test('a done-done source: each failed step of a failed, inconclusive or overridden verify run is a record; a passed run is not; an unknown schema or bad steps stop with the fix', () => {
  const { p, lfm, env } = setup();
  env.DONE_DONE_HOME = join(p, 'dd-home'); // done-done's own default when the source sets no path
  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString(); // inside the 7d window, unlike a fixed date
  const UPDATED = ago(2), ENDED = ago(3);
  const run = (id, run) => {
    mkdirSync(join(env.DONE_DONE_HOME, 'runs', 'notes', id), { recursive: true });
    writeFileSync(join(env.DONE_DONE_HOME, 'runs', 'notes', id, 'run.json'), JSON.stringify({ schema: 2, run_id: id, kind: 'verify', app: 'notes', status: 'completed', updated: UPDATED, ...run }));
  };
  const steps = (failed) => ['resolve', 'drive', 'check', 'report'].map((name) => ({ name, status: name === failed ? 'failed' : 'completed', ...(name === failed && { exit: 1, ended: ENDED }) }));
  run('r1', { result: 'fail', reason: 'check: shot.png: judge says wrong screen; token=ghp_aaaaaaaaaaaaaaaaaaaaaaaa', steps: steps('check') });
  run('r2', { result: 'inconclusive', reason: 'drive: journey timed out after 30m', steps: steps() }); // no failed step: the step its reason names
  run('r3', { result: 'pass', steps: steps() });
  run('r4', { status: 'running', steps: steps('drive') }); // not finished
  run('r6', { result: 'overridden', reason: 'gate: Umer chose approve: the shot is right', steps: [{ name: 'judge', status: 'failed', exit: 1, findings: [{ level: 'fail', why: 'shot.png: judge says wrong screen' }] }, { name: 'gate', status: 'completed' }] });
  run('r7', { status: 'failed', reason: 'setup: .done-done.yaml: bad key', steps: steps().map((x) => ({ ...x, status: 'skipped' })) }); // failed before its first step
  mkdirSync(join(env.DONE_DONE_HOME, 'runs', 'notes', 'judge')); // done-done's judge cache: no run.json
  run('old', { schema: 3, updated: ago(60), result: 'fail', steps: steps('check') }); // a newer schema, before the window: skipped unread
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  dd: { type: done-done, apps: [notes, nottes] }\n');
  const bin = join(p, '..', 'dd-bin'); // the retro's worker and judge are the fake one, never the host's claude login
  mkdirSync(bin);
  symlinkSync(FAKE_AGENT, join(bin, 'claude'));
  symlinkSync(FAKE_AGENT, join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const retro = () => spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--json', '--dir', p], { encoding: 'utf8', env: { ...env, PATH: bin } });
  const read = retro();
  assert.equal(read.status, 0, read.stderr);
  const records = readFileSync(join(p, '.lfm', 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  // The record id is keyed with the store's salt, and the bundle scrubs the ref's app folder, so the model the bundle
  // goes to reads neither the app name nor its folder; the stored ref stays the run file a person can open.
  const salt = Buffer.from(db.prepare('SELECT salt FROM secret').get().salt);
  const dd = (id, step) => `dd:${saltedId(salt, `notes/${id}/${step}`)}`;
  const file = (id) => join(env.DONE_DONE_HOME, 'runs', 'notes', id, 'run.json');
  const ref = (id) => join('<done-done home>', 'runs', saltedId(salt, 'notes'), id, 'run.json');
  assert.deepEqual(records, [
    { id: dd('r1', 'check'), source: 'dd', step: 'check', ref: file('r1'), date: ENDED.slice(0, 10), text: 'verify fail: check: shot.png: judge says wrong screen; token=[redacted]' },
    { id: dd('r2', 'drive'), source: 'dd', step: 'drive', ref: file('r2'), date: UPDATED.slice(0, 10), text: 'verify inconclusive: drive: journey timed out after 30m' },
    { id: dd('r6', 'judge'), source: 'dd', step: 'judge', ref: file('r6'), date: UPDATED.slice(0, 10), text: 'verify overridden: judge: shot.png: judge says wrong screen' },
    { id: dd('r7', 'setup'), source: 'dd', step: 'setup', ref: file('r7'), date: UPDATED.slice(0, 10), text: 'verify failed: setup: .done-done.yaml: bad key' }]);
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(JSON.parse(read.stdout).run.id), 'bundle.md'), 'utf8');
  for (const [id, step] of [['r1', 'check'], ['r2', 'drive'], ['r6', 'judge'], ['r7', 'setup']]) assert.ok(bundle.includes(`[${dd(id, step)}]`), bundle);
  assert.ok(bundle.includes(ref('r1')), bundle);
  assert.doesNotMatch(bundle, /notes/);
  const doctor = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'source dd');
  assert.match(doctor.detail, /^done-done: 4 failed or inconclusive verify steps, 4 in the window; no runs for nottes in /);
  assert.match(doctor.fix, /^ls .*# done-done's app names; set sources\.dd\.apps in /);
  const rows = db.prepare('SELECT record_id, ref FROM records ORDER BY record_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows,
    [['r1', 'check'], ['r2', 'drive'], ['r6', 'judge'], ['r7', 'setup']].map(([id, step]) => ({ record_id: dd(id, step), ref: file(id) })).toSorted((a, b) => (a.record_id < b.record_id ? -1 : 1)));
  for (const { ref } of rows) assert.ok(statSync(ref).isFile(), ref); // the stored ref opens: it is the run file itself
  db.close();

  // A config edit between collect and a resumed bundle: the run state is the documented interrupted-worker state, so
  // `rerun --resume` re-runs the bundle step from the new config over the stored records. The line keeps the id and
  // withholds the path, and no app name or done-done home reaches the model.
  const runId = String(JSON.parse(read.stdout).run.id);
  const drift = (config) => {
    writeFileSync(join(p, '.learn-from-mistakes.yaml'), config);
    const w = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
    w.prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(runId); // its worker (the retro process) is gone
    w.prepare(`UPDATE steps SET status = 'pending' WHERE run_id = ? AND ord >= 3`).run(runId); // bundle and after re-run
    w.close();
    const resumed = JSON.parse(lfm('rerun', '--resume', '--run', runId, '--wait', '1m', '--json').stdout);
    assert.equal(resumed.run.status, 'completed', JSON.stringify(resumed.steps));
    const text = readFileSync(join(p, '.lfm', 'runs', runId, 'bundle.md'), 'utf8');
    for (const [id, step] of [['r1', 'check'], ['r2', 'drive'], ['r6', 'judge'], ['r7', 'setup']]) assert.ok(text.includes(`[${dd(id, step)}]`), text);
    assert.match(text, / at an unknown path, /, text);
    assert.doesNotMatch(text, /notes|dd-home/, text);
  };
  drift('sources:\n  dd: { type: done-done, apps: [notes], path: elsewhere }\n'); // the source's path changed under the stored refs
  drift('sources:\n  dd2: { type: done-done, apps: [notes], path: dd-home }\n'); // the source id is gone: the records are orphans

  run('r5', { schema: 3, result: 'fail', steps: steps('check') }); // a newer done-done: never skipped, never a crash
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  dd: { type: done-done, apps: [notes], path: dd-home }\n');
  const source = () => { // doctor names the source's problem and its fix; a retro fails at collect
    const r = lfm('doctor', '--json');
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(retro().stdout).run.error.startsWith('collect: source dd: '), true);
    return JSON.parse(r.stdout).checks.find((c) => c.label === 'source dd');
  };
  const newer = source();
  assert.equal(newer.detail, `done-done: ${file('r5')} is done-done run schema 3; this version reads schema 2`);
  assert.match(newer.fix, /^update learn-from-mistakes-axi to read it, or remove sources\.dd from /);
  run('r5', { result: 'fail', steps: [null] });
  const broken = source();
  assert.equal(broken.detail, `done-done: ${file('r5')} is not done-done run state (steps)`);
  assert.match(broken.fix, /^done-done status --run r5   # in the notes repo/);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  dd: { type: done-done, apps: [../x] }\n');
  assert.match(lfm('changes').stderr, /^error: .*: sources\.dd\.apps must be a list of done-done app names$/m);

  // A malformed run between one and two windows ago: the retro reads it, so doctor checks it too.
  run('bad-old', { result: 'fail', updated: ago(10), steps: [null] });
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  dd: { type: done-done, apps: [notes], path: dd-home }\n');
  const stale = source();
  assert.equal(stale.level, 'fail');
  assert.equal(stale.detail, `done-done: ${file('bad-old')} is not done-done run state (steps)`);
});

test('change applied appends an append-only ledger the report counts and changes exports', () => {
  const { p, lfm } = setup();
  const ledger = join(p, '.lfm', 'changes.jsonl');
  const change = (...args) => lfm('change', 'applied', ...args);
  const exported = (...args) => {
    const r = lfm('changes', ...args);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const empty = JSON.parse(exported('--json').stdout); // needs the config only: no run, no ledger yet
  assert.equal(empty.schema, 'lfm-changes.v1');
  assert.deepEqual(empty.changes, []);
  assert.equal(change('--cause', 'nope', '--ref', 'abc1234').status, 2); // rejected input creates nothing
  assert.ok(!existsSync(ledger));
  // Private prose sits in a source record; it must never reach any change or report output.
  appendFileSync(join(p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  assert.equal(lfm('retro', '--foreground').status, 0);

  const first = change('--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(first.status, 0, first.stderr);
  const firstEntry = decode(first.stdout); // one TOON object on stdout
  assert.deepEqual(Object.keys(firstEntry).sort(), ['at', 'cause', 'check', 'id', 'kind', 'metric', 'ref', 'v']); // no --tripwire: none saved; the check is the default retro
  assert.deepEqual({ v: firstEntry.v, id: firstEntry.id, cause: firstEntry.cause, ref: firstEntry.ref, metric: firstEntry.metric, kind: firstEntry.kind },
    { v: 1, id: 'chg-1', cause: 'server-memory-kill', ref: 'abc1234', metric: 'cause_count:server-memory-kill', kind: 'doc' }); // the defaults
  assert.ok(!Number.isNaN(Date.parse(firstEntry.at)), 'default --at is a readable time');
  assert.match(first.stderr, /next: learn-from-mistakes-axi report   # the report with the ledger/);
  const afterFirst = readFileSync(ledger);
  assert.deepEqual(JSON.parse(afterFirst.toString()), firstEntry);

  const AT = '2026-01-02T03:04:05Z';
  const REF2 = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  // Owner text a report must never carry; commas, quotes and colons stress the TOON table.
  const WHAT = 'OWNER-WHAT-41c2: builds run in their own "memory group", 🙂';
  const WHY = 'OWNER-WHY-7d0e: the killer, not the build, stopped the server';
  const second = change('--cause', 'server-memory-kill', '--ref', REF2, '--at', AT, '--metric', 'tool_error_rate', '--tripwire', '<=0.05', '--kind', 'rule',
    '--what', `  ${WHAT} `, '--why', WHY, '--json');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { v: 1, id: 'chg-2', cause: 'server-memory-kill', ref: REF2, at: '2026-01-02T03:04:05.000Z',
    metric: 'tool_error_rate', tripwire: '<= 0.05', kind: 'rule', check: 'learn-from-mistakes-axi retro --wait 15m' }); // the echo never carries what/why; the tripwire in one form
  const afterSecond = readFileSync(ledger);
  assert.ok(afterSecond.subarray(0, afterFirst.length).equals(afterFirst)); // the second entry keeps every prior byte

  for (const args of [
    ['--cause', 'nope', '--ref', 'abc1234'], // unknown cause
    ['--cause', 'other', '--ref', 'abc1234'], // `other` is never recordable
    ['--cause', 'server-memory-kill', '--ref', 'xyz'], // bad ref
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--at', 'not-a-time'], // bad --at
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--bogus'], // unknown flag
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--full'], // --full is report-only
    ['--cause', 'server-memory-kill'], // missing --ref
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what', ''], // empty what
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--why', '   '], // blank why
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what', 'x'.repeat(201)], // 201 characters
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--why', 'line one\nline two'], // newline
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what', 'bell\u0007'], // control character
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what'], // missing value
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--tripwire', '< x'], // bad tripwire
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--metric', 'speed'], // unknown metric
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--kind', 'policy'], // unknown kind
  ]) {
    assert.equal(change(...args).status, 2, args.join(' '));
    assert.ok(readFileSync(ledger).equals(afterSecond), `rejected input changed the ledger: ${args.join(' ')}`);
  }
  const badWhy = change('--cause', 'server-memory-kill', '--ref', 'abc1234', '--why', `${WHY}\nsecond line`);
  assert.match(badWhy.stderr, /^error: --why \(invalid value\) must be one line of 1-200 characters/m); // the rule, never the text
  assert.doesNotMatch(badWhy.stderr, /OWNER-WHY/);
  appendFileSync(ledger, 'not json\n');
  const beforeRetry = readFileSync(ledger);
  const corrupt = change('--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /^error: .*changes\.jsonl:3: not valid JSON$/m);
  assert.match(corrupt.stderr, /^next: learn-from-mistakes-axi changes   # check the ledger again/m);
  assert.doesNotMatch(corrupt.stderr, /not json\n/); // file:line only, never line contents
  assert.ok(readFileSync(ledger).equals(beforeRetry));
  const corruptExport = lfm('changes', '--json');
  assert.equal(corruptExport.status, 1);
  assert.equal(corruptExport.stdout, ''); // no partial export to join on
  assert.match(corruptExport.stderr, /changes\.jsonl:3: not valid JSON/);
  for (const bad of [{ id: 'chg-3', what: 'line one\nline two' }, { id: 'chg-3', why: 'x'.repeat(201) }, { id: 'chg-3', tripwire: '< x' },
    { id: 'chg-3', kind: 'policy' }, { id: 'chg-3', metric: '' }, { id: 'chg-3', metric: 'cause_count:a\nb' }, { id: 'chg-3', metric: 'x'.repeat(201) },
    { id: 'chg-3', at: 'not a time' }, { id: 'chg-2' }]) {
    writeFileSync(ledger, Buffer.concat([afterSecond, Buffer.from(JSON.stringify({ v: 1, cause: 'server-memory-kill', ref: 'abc1234', at: AT, ...bad }) + '\n')]));
    const r = lfm('changes', '--json'); // a hand-edited ledger never exports bad text or a repeated join key
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, bad.id === 'chg-2' ? /changes\.jsonl:3: repeats change id "chg-2"/ : /changes\.jsonl:3: not a valid change entry/);
  }
  writeFileSync(ledger, afterSecond); // repair the scratch corruption for the report below

  for (const args of [['--full'], ['--labels', 'x'], ['--cause', 'server-memory-kill'], ['--what', 'x']]) {
    assert.equal(lfm('changes', ...args).status, 2, args.join(' ')); // report and change-applied flags are not export flags
  }
  const changesJson = exported('--json'); // a fresh process reads the persisted ledger
  const exportModel = JSON.parse(changesJson.stdout);
  assert.deepEqual(Object.keys(exportModel), ['schema', 'generated_at', 'project', 'changes']);
  assert.equal(exportModel.schema, 'lfm-changes.v1');
  assert.equal(exportModel.project, 'example');
  assert.ok(!Number.isNaN(Date.parse(exportModel.generated_at)));
  assert.deepEqual(exportModel.changes, [
    { id: 'chg-1', cause: 'server-memory-kill', ref: 'abc1234', at: firstEntry.at, metric: 'cause_count:server-memory-kill', tripwire: '', kind: 'doc', check: 'learn-from-mistakes-axi retro --wait 15m', what: '', why: '' },
    { id: 'chg-2', cause: 'server-memory-kill', ref: REF2, at: '2026-01-02T03:04:05.000Z', metric: 'tool_error_rate', tripwire: '<= 0.05', kind: 'rule', check: 'learn-from-mistakes-axi retro --wait 15m', what: WHAT, why: WHY },
  ]);
  assert.match(changesJson.stderr, /next: learn-from-mistakes-axi report /);
  const changesToon = exported();
  assert.deepEqual({ ...decode(changesToon.stdout), generated_at: exportModel.generated_at }, exportModel); // TOON decodes equal to JSON
  assert.match(changesToon.stderr, /next: learn-from-mistakes-axi changes --json/);

  const json = lfm('report', '--json'); // a fresh process reads the persisted ledger
  assert.equal(json.status, 0, json.stderr);
  const model = JSON.parse(json.stdout);
  assert.equal(model.schema, 'lfm-report.v2');
  assert.deepEqual(model.ledger, { entries: 2 });
  assert.deepEqual(model.causes.find((c) => c.cause === 'server-memory-kill').changes, { count: 2, last_at: firstEntry.at });
  assert.deepEqual(model.causes.find((c) => c.cause === 'agent-exit-wait').changes, { count: 0, last_at: '' });
  const bare = lfm('report');
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual({ ...decode(toonBodyOf(bare.stdout)), generated_at: model.generated_at }, model); // TOON decodes equal to JSON
  assert.equal(summaryOf(bare.stdout), 'repeated: agent-exit-wait (4 times/3 days)');
  const fullRun = lfm('report', '--full', '--json');
  assert.equal(fullRun.status, 0, fullRun.stderr);
  const fullMem = JSON.parse(fullRun.stdout).causes.find((c) => c.cause === 'server-memory-kill');
  assert.deepEqual(fullMem.change_ids, ['chg-1', 'chg-2']);
  assert.deepEqual(fullMem.change_refs, ['abc1234', REF2]);
  for (const out of [first.stdout, first.stderr, second.stdout, second.stderr, json.stdout, json.stderr, bare.stdout, fullRun.stdout,
    changesJson.stdout, changesJson.stderr, changesToon.stdout, changesToon.stderr]) {
    assert.doesNotMatch(out, new RegExp(CANARY));
  }
  for (const out of [second.stdout, json.stdout, json.stderr, bare.stdout, bare.stderr, fullRun.stdout, fullRun.stderr]) {
    assert.doesNotMatch(out, /OWNER-WHAT|OWNER-WHY/); // what/why reach only `changes`, never the report
  }

  const third = change('--cause', 'shared-cache-lock', '--ref', 'def5678', '--what', 'x'.repeat(200), '--why', 'y'); // 200 is the limit
  assert.equal(third.status, 0, third.stderr);
  const later = JSON.parse(exported('--json').stdout);
  assert.deepEqual(later.changes.slice(0, 2), exportModel.changes); // ids are stable after a later append
  assert.deepEqual(later.changes[2], { id: 'chg-3', cause: 'shared-cache-lock', ref: 'def5678', at: later.changes[2].at,
    metric: 'cause_count:shared-cache-lock', tripwire: '', kind: 'doc', check: 'learn-from-mistakes-axi retro --wait 15m', what: 'x'.repeat(200), why: 'y' });

  // A line written before the metric, tripwire and kind fields still loads, with the defaults, and the ledger goes on.
  appendFileSync(ledger, `${JSON.stringify({ v: 1, id: 'chg-4', cause: 'agent-exit-wait', ref: 'abc1234', at: AT })}\n`);
  const fifth = change('--cause', 'agent-exit-wait', '--ref', 'abc1234', '--metric', 'cause_count:server-memory-kill', '--tripwire', '>= 1', '--json');
  assert.equal(fifth.status, 0, fifth.stderr);
  assert.equal(JSON.parse(fifth.stdout).id, 'chg-5');
  assert.deepEqual(JSON.parse(exported('--json').stdout).changes.slice(3).map(({ id, metric, tripwire, kind }) => ({ id, metric, tripwire, kind })), [
    { id: 'chg-4', metric: 'cause_count:agent-exit-wait', tripwire: '', kind: 'doc' },
    { id: 'chg-5', metric: 'cause_count:server-memory-kill', tripwire: '>= 1', kind: 'doc' }, // any configured cause's count
  ]);
  assert.deepEqual(JSON.parse(lfm('report', '--json').stdout).ledger, { entries: 5 });

  // The default metric comes from the cause key as the config spells it; the ledger still reads.
  assert.equal(change('--cause', 'agent-exit-wait', '--ref', 'abc1234').status, 0);
  assert.deepEqual(JSON.parse(exported('--json').stdout).changes.slice(5).map((c) => c.metric), ['cause_count:agent-exit-wait']);

  // This test's project is deliberately not a git repo: outside one today's behaviour stands and a hex ref records
  // unverified. A git project, though, refuses a hex ref that names no commit, before anything is written.
  const { p: g, lfm: lfmG } = setup();
  execFileSync('git', ['-C', g, 'init', '-q']);
  execFileSync('git', ['-C', g, '-c', 'user.name=umer', '-c', 'user.email=umer@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'one']);
  const sha = execFileSync('git', ['-C', g, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const unknown = lfmG('change', 'applied', '--cause', 'server-memory-kill', '--ref', '1234567');
  assert.equal(unknown.status, 1, unknown.stderr); // the README's input-problem exit code
  assert.match(unknown.stderr, /^error: --ref "1234567" names no commit in this git project$/m);
  assert.match(unknown.stderr, /^next: git log --oneline -5   # a commit id to pass as --ref$/m);
  assert.deepEqual(JSON.parse(lfmG('changes', '--json').stdout).changes, []); // nothing reached the ledger
  assert.ok(!existsSync(join(g, '.lfm'))); // not even the state dir was created
  const real = lfmG('change', 'applied', '--cause', 'server-memory-kill', '--ref', sha);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(decode(real.stdout).ref, sha); // the ref is stored as the user typed it
  const sha256 = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // a version id, never a git ref
  assert.equal(lfmG('change', 'applied', '--cause', 'server-memory-kill', '--ref', sha256).status, 0);
  assert.deepEqual(JSON.parse(lfmG('changes', '--json').stdout).changes.map((c) => c.ref), [sha, sha256]);
});

test('the defects metric counts the defect log, not reviews.md', () => {
  const { p, env } = setup();
  execFileSync('git', ['-C', p, 'init', '-q']);
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(p, 'defects.md'), `## ${day}\n- one\n- two\n- three\n`);
  writeFileSync(join(p, 'reviews.md'), `- ${day} umer: first review\n- ${day} umer: second review\n`);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n  reviews: { type: markdown-log, path: reviews.md }\ncauses: { flaky: { description: d } }\n');
  // PATH holds only the fake agent (the worker and the judge), so the run never calls a real, logged-in agent.
  const bin = join(p, '..', 'bin');
  mkdirSync(bin);
  symlinkSync(FAKE_AGENT, join(bin, 'claude'));
  symlinkSync(FAKE_AGENT, join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const r = spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--dir', p], { encoding: 'utf8', env: { ...env, PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(decode(r.stdout).run.id), 'bundle.md'), 'utf8');
  assert.match(bundle, /^\| defects \| 3 \|/m);
});

test('a markdown-log heading dates its bullets in the log\'s date forms: ISO, D Mon[th] [YYYY], Mon[th] D, YYYY; no year is the latest year on or before today, and 29 Feb the latest leap year', () => {
  const { p, env } = setup();
  execFileSync('git', ['-C', p, 'init', '-q']);
  // The acceptance finding's own file: before the heading parser read the log's other date forms, only the ISO heading
  // dated its bullet and the other three bullets were skipped (no date); now every bullet carries its heading's date.
  writeFileSync(join(p, 'defects.md'), '# Defects\n## 2026-10-14\n- Umer: tests failed\n## 12 Oct\n- Umer: lint failed on a stale import\n- Umer: the build broke on a missing type\n## 15 Oct 2026\n- Umer: wrong flag in the release script\n## 29 Feb\n- Umer: the leap-day migration ran twice\n');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\ncauses: { flaky: { description: d } }\n');
  // PATH holds only the fake agent (the worker and the judge), so the run never calls a real, logged-in agent.
  const bin = join(p, '..', 'bin');
  mkdirSync(bin);
  symlinkSync(FAKE_AGENT, join(bin, 'claude'));
  symlinkSync(FAKE_AGENT, join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const r = spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--dir', p], { encoding: 'utf8', env: { ...env, PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  const records = readFileSync(join(p, '.lfm', 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let y = new Date().getUTCFullYear(); // the no-year rule: the latest `12 Oct` on or before today
  while (Date.parse(`${y}-10-12`) > Date.now()) y -= 1;
  let leap = new Date().getUTCFullYear(); // `29 Feb` with no year: the latest leap year whose 29 Feb is on or before today
  while (new Date(Date.UTC(leap, 1, 29)).getUTCDate() !== 29 || Date.UTC(leap, 1, 29) > Date.now()) leap -= 1;
  assert.deepEqual(records.map((x) => [x.line, x.date]).sort((a, b) => a[0] - b[0]), [
    [3, '2026-10-14'], [5, `${y}-10-12`], [6, `${y}-10-12`], [8, '2026-10-15'], [10, `${leap}-02-29`]]);
  const doctor = JSON.parse(spawnSync(process.execPath, [CLI, 'doctor', '--json', '--dir', p], { encoding: 'utf8', env }).stdout).checks.find((c) => c.label === 'source log');
  assert.match(doctor.detail, /^markdown-log: 5 records, \d+ in the window, 0 skipped \(no date\)$/);
});

test('retro --foreground saves a run and its steps in .lfm/; status and runs show it', () => {
  const { p, lfm } = setup();
  const git = (...args) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const none = lfm('status'); // before any run: nothing to read, and reads never create state
  assert.equal(none.status, 3, none.stderr);
  assert.match(none.stderr, /^next: learn-from-mistakes-axi retro --wait 8m   # read, label and count the sources as a saved run \(keep your --dir\)$/m);
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout), { runs: [] });
  assert.ok(!existsSync(join(p, '.lfm')));

  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/); // the examples read a store, so node:sqlite loads
  const run = decode(r.stdout);
  assert.equal(run.run.status, 'completed');
  assert.deepEqual(run.steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['verify', 'completed'], ['context', 'completed'], ['propose', 'completed'], ['verify-fixes', 'completed'], ['check', 'completed'], ['apply', 'completed'], ['report', 'completed']]);
  // The bundle: the metrics; the example's records and gate rows are all from March, before this window.
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'bundle.md'), 'utf8');
  assert.match(bundle, /^\| defects \| 0 \| 0 \|  \|$/m);
  assert.match(bundle, /^No follow-ups yet\.$/m);
  assert.match(bundle, /^No session event has a failure signal in this window\.$/m);
  assert.match(bundle, /^No record in this window lacks a label\.$/m);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  const steps = db.prepare('SELECT name, output_json FROM steps WHERE run_id = ? ORDER BY ord').all(run.run.id);
  db.close();
  assert.deepEqual(JSON.parse(steps[0].output_json).sources.map((s) => s.items), [13, 5]);
  assert.deepEqual(JSON.parse(steps.at(-1).output_json).coverage, { labelled: 0, total_records: 18, unlabelled: 18 }); // no labels yet
  const status = lfm('status', '--json');
  assert.equal(status.status, 0, status.stderr);
  const saved = JSON.parse(status.stdout);
  assert.ok(saved.run.pid > 0, 'the run keeps its owner pid for --json');
  delete saved.run.pid; // the human output hides the internal pid
  assert.deepEqual(saved, run);
  assert.deepEqual(decode(lfm('runs').stdout), { runs: [run.run] });
  assert.doesNotMatch(lfm('status').stdout, /\bpid\b/); // status and runs name no internal word in the human output
  assert.doesNotMatch(lfm('runs').stdout, /\bpid\b/);
  assert.doesNotMatch(git('status', '--porcelain', '--untracked-files=all'), /\.lfm/);

  // A project config with every key, and a global config with the agent keys, loads and runs the same steps.
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `${readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8')}agent: claude
judge_agent: codex
agent_config: { "acp:gemini": { model: cheap-model }, claude: { effort: low } }
agent_timeout: 20m
window: 30d
targets: { first_pass: ">= 70", p90_hours_to_merge: "<= 8", escaped: "<= 0", "cause_count:server-memory-kill": "<= 1" }
followup: { min_sessions: 3, min_days: 2 }
excerpts: off
caps: { invocations: 14, bundle_chars: 60000 }
signoff: on
`);
  mkdirSync(join(p, '..', 'home'), { recursive: true });
  writeFileSync(join(p, '..', 'home', 'config.yaml'), 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna, effort: low } }\nagent_timeout: 5m\nagent_path_override: { claude: ' + FAKE_AGENT + ' }\nagent_args_override: { codex: [--profile, cheap] }\nacpx_path: acpx\n');
  const v2 = lfm('retro', '--foreground', '--json');
  assert.equal(v2.status, 0, v2.stderr);
  assert.deepEqual(JSON.parse(v2.stdout).steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['verify', 'completed'], ['context', 'completed'], ['propose', 'completed'], ['verify-fixes', 'completed'], ['check', 'completed'], ['apply', 'completed'], ['report', 'completed']]);
  writeFileSync(join(p, '..', 'home', 'config.yaml'), 'agent_args_override: { codex: --profile }\n');
  const badGlobal = lfm('status');
  assert.equal(badGlobal.status, 2, badGlobal.stderr);
  assert.match(badGlobal.stderr, /^error: .*config\.yaml: agent_args_override\.codex must be a list of strings$/m);

  writeFileSync(join(p, 'defects.md'), ''); // a failed step fails the run with exit 1 and saves the error
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  // With no agent set, a run is never started on an agent the tool picked: a caller that is not a terminal is told to
  // ask the user, with the choices and the init command that saves the answer.
  rmSync(join(p, '..', 'home', 'config.yaml'));
  const unset = lfm('retro', '--foreground');
  assert.equal(unset.status, 2, unset.stderr);
  assert.match(unset.stderr, /^error: ask the user which agent to use: agent and judge_agent are not set in \S+\.learn-from-mistakes\.yaml, and the tool never picks one\. Choices: claude, codex, opencode, pi or byokit:<route>/m);
  assert.match(unset.stderr, /^next: learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir \S+   # with the user's answer$/m);
  writeFileSync(join(p, '..', 'home', 'config.yaml'), AGENTS_SET);
  const failed = lfm('retro', '--foreground', '--json');
  assert.equal(failed.status, 1, failed.stderr);
  const f = JSON.parse(failed.stdout);
  assert.equal(f.run.error, 'report: no records or rows in the sources: nothing to count');
  // A failed run keeps no verdict: the steps from followup on are pending again, for a resume to run them.
  assert.deepEqual(f.steps.map((s) => s.status), ['completed', 'completed', ...Array(9).fill('pending'), 'failed']);
  assert.match(failed.stderr, /^error: report: no records or rows in the sources: nothing to count$/m);
  assert.match(failed.stderr, /^next: learn-from-mistakes-axi rerun --resume --run \d+   # finish it after fixing the report step/m);
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout).runs[0], f.run);
  const later = JSON.parse(lfm('status', '--json', '--run', String(run.run.id)).stdout);
  delete later.run.pid; // --json keeps the owner pid; the human retro output hides it
  assert.deepEqual(later, run);
  const missing = lfm('status', '--run', '99');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: no run 99$/m);

  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: gone.md }\n  store: { type: no-mistakes, path: gone.sqlite }\n');
  const unreadable = lfm('retro', '--foreground', '--json');
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.equal(JSON.parse(unreadable.stdout).run.error, 'collect: source log: cannot read (ENOENT) (0 records read)');
  assert.match(unreadable.stderr, /^error: collect: source log: cannot read \(ENOENT\) \(0 records read\)$/m);
  assert.ok(!unreadable.stdout.includes(p) && !unreadable.stderr.includes(p), 'a source path must not reach machine output');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  store: { type: no-mistakes, path: gone.sqlite }\n');
  const noStore = lfm('retro', '--foreground', '--json');
  assert.equal(JSON.parse(noStore.stdout).run.error, 'collect: source store: no such file (0 records read)');
  assert.ok(!noStore.stdout.includes(p) && !noStore.stderr.includes(p), 'a source path must not reach machine output');

  const hold = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite')); // another process holds the write lock past busy_timeout
  hold.exec('BEGIN IMMEDIATE');
  const read = lfm('status', '--json'); // a read command takes the write lock only when a running run has lost its worker
  const busy = lfm('retro', '--foreground');
  hold.exec('ROLLBACK');
  hold.close();
  assert.equal(read.status, 1, read.stderr); // status shows the failed run: the failed-run exit code
  assert.equal(JSON.parse(read.stdout).run.error, 'collect: source store: no such file (0 records read)');
  assert.equal(busy.status, 2, busy.stderr);
  assert.match(busy.stderr, /^error: .*lfm\.sqlite is busy: another learn-from-mistakes-axi process is writing it\nnext: learn-from-mistakes-axi status   # wait a moment and check the running run; abort --run <id> stops it \(keep your --dir\)\n$/);
  assert.equal(JSON.parse(lfm('status', '--json').stdout).run.error, 'collect: source store: no such file (0 records read)'); // the store keeps its runs

  chmodSync(join(p, '.lfm'), 0o555); // a readable store that cannot be written is not a run store: no mv hint
  chmodSync(join(p, '.lfm', 'lfm.sqlite'), 0o444);
  const readonly = lfm('status');
  const readonlyBare = lfm(); // the bare command must name itself, not its internal alias
  chmodSync(join(p, '.lfm', 'lfm.sqlite'), 0o644);
  chmodSync(join(p, '.lfm'), 0o755);
  assert.equal(readonly.status, 2, readonly.stderr);
  assert.doesNotMatch(readonly.stderr, /^next: mv /m);
  assert.match(readonly.stderr, /^next: learn-from-mistakes-axi status   # after the disk or the file permissions are fixed/m);
  assert.equal(readonlyBare.status, 2, readonlyBare.stderr);
  assert.match(readonlyBare.stderr, /^next: learn-from-mistakes-axi   # after the disk or the file permissions are fixed/m);

  writeFileSync(join(p, '.lfm', 'lfm.sqlite'), 'not a database '.repeat(64));
  const corrupt = lfm('status');
  assert.equal(corrupt.status, 2, corrupt.stderr);
  assert.match(corrupt.stderr, /^error: .*lfm\.sqlite: not a usable run store/m);
  assert.match(corrupt.stderr, /^next: mv .*lfm\.sqlite <elsewhere>/m);
  assert.doesNotMatch(corrupt.stderr, /\n\s+at /); // no stack trace
});

test('retro runs in a detached worker; a killed worker is interrupted and rerun --resume finishes it', async () => {
  const { p, lfm, env } = setup();
  const waited = lfm('retro', '--wait', '1m', '--json');
  assert.equal(waited.status, 0, waited.stderr);
  assert.doesNotMatch(waited.stderr, /ExperimentalWarning/);
  const first = JSON.parse(waited.stdout);
  assert.equal(first.run.status, 'completed');
  assert.deepEqual(first.steps.map((s) => s.status), Array(12).fill('completed'));
  // A run whose worker labelled nothing and found nothing says so in one plain line, with where to see why.
  assert.deepEqual(first.result, { summary: 'repeated: agent-exit-wait (4 times/3 days)', labelled: 0, records: 18, causes: [{ cause: 'agent-exit-wait', repeated: true, incidents: 0, days: 0, rows: 4 }], findings: [] }); // a match rule counts gate rows
  assert.match(waited.stderr, /^result: the worker labelled no record and named no finding\nnext: learn-from-mistakes-axi logs --step analyse --run 1   # why/m);

  // Without --wait, retro returns while the worker runs: spawnSync ends only when no process holds its pipes.
  const slowEnv = { ...env, LFM_TEST_SLOW_STEP: 'report' }; // the worker inherits it: report sleeps 60 s
  const started = spawnSync(process.execPath, [CLI, 'retro', '--json', '--dir', p], { encoding: 'utf8', env: slowEnv });
  assert.equal(started.status, 0, started.stderr);
  const { run } = JSON.parse(started.stdout);
  after(() => { try { process.kill(run.pid, 'SIGKILL'); } catch {} }); // a failed assertion must not leave the slow worker behind
  assert.equal(run.status, 'running');
  assert.match(started.stderr, new RegExp(`^next: learn-from-mistakes-axi attach --run ${run.id}   # follow its steps while the run goes on in the background`, 'm'));
  let steps;
  for (let i = 0; i < 100; i++) { // up to 20 s for the worker to reach the slow step
    steps = (await statusJson(() => lfm('status', '--json'))).steps;
    if (steps.at(-1).status === 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.deepEqual(steps.map((s) => s.status), [...Array(11).fill('completed'), 'running']);
  const busy = lfm('retro');
  assert.equal(busy.status, 2, busy.stderr);
  assert.match(busy.stderr, new RegExp(`^error: run ${run.id} is still running$`, 'm'));

  process.kill(run.pid, 'SIGKILL'); // a crash: no trap runs, so only reconcile can see it
  for (let i = 0; i < 50 && (await statusJson(() => lfm('status', '--json'))).run.status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  const killed = lfm('status', '--json');
  assert.equal(killed.status, 1, killed.stderr); // an interrupted run is exit 1 for status too
  const k = JSON.parse(killed.stdout);
  assert.equal(k.run.status, 'interrupted');
  assert.equal(k.run.error, 'report: the worker stopped before the step ended');
  // An interrupted run keeps no verdict: its steps from followup on are pending again.
  assert.deepEqual(k.steps.map((s) => s.status), ['completed', 'completed', ...Array(9).fill('pending'), 'interrupted']);
  assert.match(killed.stderr, new RegExp(`^next: learn-from-mistakes-axi rerun --resume --run ${run.id}   # finish it`, 'm'));

  const next = lfm('retro', '--wait', '--json'); // the interrupted run blocks nothing; a bare --wait waits 8 minutes
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).run.status, 'completed');

  const resumed = lfm('rerun', '--resume', '--run', String(run.id), '--wait', '1m', '--json');
  assert.equal(resumed.status, 0, resumed.stderr);
  const r = JSON.parse(resumed.stdout);
  assert.equal(r.run.status, 'completed');
  assert.equal(r.run.error, null);
  assert.deepEqual(r.steps.map((s) => s.status), Array(12).fill('completed'));
  assert.deepEqual(r.steps.slice(0, 2), k.steps.slice(0, 2), 'the completed collect and metrics steps were not run again');
  assert.deepEqual(r.metrics, k.metrics);
  const again = lfm('rerun', '--resume', '--run', String(run.id));
  assert.equal(again.status, 2, again.stderr);
  assert.match(again.stderr, new RegExp(`^error: run ${run.id} already completed$`, 'm'));
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout).runs.map((x) => x.status), ['completed', 'completed', 'completed']);
});

test('attach follows a run to its end; logs prints one step; abort cancels a run and rerun starts it again', async () => {
  const { p, lfm, env } = setup();
  const none = lfm('attach');
  assert.equal(none.status, 3, none.stderr); // nothing to follow yet

  // A slow fixture run: attach prints each step's lines and state changes, then the run, and exits 0.
  const started = spawnSync(process.execPath, [CLI, 'retro', '--json', '--dir', p], { encoding: 'utf8', env: { ...env, LFM_TEST_SLOW_STEP: 'report:3000' } });
  assert.equal(started.status, 0, started.stderr);
  const first = JSON.parse(started.stdout).run;
  const attached = lfm('attach');
  assert.equal(attached.status, 0, attached.stderr);
  const lines = attached.stdout.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  const order = [/^collect: log +markdown-log +13 items$/, /^collect: gate +no-mistakes +5 items$/, /^collect: completed$/,
    /^bundle: bundle\.md: \d+ items, 1 part, \d+ characters$/, /^report: running$/, /^report: repeated: /, /^report: completed$/, /^run:$/];
  assert.ok(order.every((re) => at(re) >= 0), attached.stdout);
  assert.deepEqual(order.map(at), order.map(at).toSorted((a, b) => a - b), attached.stdout);
  assert.doesNotMatch(attached.stdout, /sha256/);
  assert.equal(decode(attached.stdout.slice(attached.stdout.indexOf('run:\n'))).run.status, 'completed');
  // The examples' records are all from March: the run says plainly it found nothing, and where to see why.
  assert.match(attached.stderr, new RegExp(`^result: the worker labelled no record and named no finding\nnext: learn-from-mistakes-axi logs --step analyse --run ${first.id}   # why`, 'm'));

  const log = lfm('logs', '--step', 'collect', '--run', String(first.id), '--json');
  assert.equal(log.status, 0, log.stderr);
  const l = JSON.parse(log.stdout);
  assert.deepEqual([l.step, l.run, l.status, l.lines, l.log.length], ['collect', first.id, 'completed', '2 total', 2]);
  assert.match(l.log[0].line, /^log +markdown-log +13 items$/);
  assert.doesNotMatch(log.stdout, /sha256/);
  const nope = lfm('logs', '--step', 'judge');
  assert.equal(nope.status, 2, nope.stderr);
  assert.match(nope.stderr, new RegExp(`^error: run ${first.id} has no step "judge" \\(steps: collect, metrics, followup, bundle, analyse, verify, context, propose, verify-fixes, check, apply, report\\)$`, 'm'));

  // abort stops a running run: its worker ends and the run is cancelled; a new retro is not blocked.
  const slow = spawnSync(process.execPath, [CLI, 'retro', '--json', '--dir', p], { encoding: 'utf8', env: { ...env, LFM_TEST_SLOW_STEP: 'report' } });
  const { run } = JSON.parse(slow.stdout);
  after(() => { try { process.kill(run.pid, 'SIGKILL'); } catch {} });
  for (let i = 0; i < 100 && (await statusJson(() => lfm('status', '--json'))).steps[9].status !== 'running'; i++) await new Promise((r) => setTimeout(r, 200)); // up to 20 s
  const busy = lfm('retro');
  assert.equal(busy.status, 2, busy.stderr);
  assert.match(busy.stderr, new RegExp(`^error: run ${run.id} is still running$`, 'm'));
  const aborted = lfm('abort', '--json');
  assert.equal(aborted.status, 0, aborted.stderr);
  const a = JSON.parse(aborted.stdout);
  assert.equal(a.run.status, 'cancelled');
  assert.equal(a.run.error, 'report: cancelled by SIGTERM'); // the worker's own trap ended it
  assert.deepEqual(a.steps.map((s) => s.status), ['completed', 'completed', ...Array(9).fill('pending'), 'cancelled']); // a cancelled run keeps no verdict either
  assert.throws(() => process.kill(run.pid, 0), { code: 'ESRCH' }, 'the worker is gone');
  assert.match(aborted.stderr, new RegExp(`^next: learn-from-mistakes-axi rerun --resume --run ${run.id}   # finish it`, 'm'));
  const idle = lfm('abort');
  assert.equal(idle.status, 2, idle.stderr);
  assert.match(idle.stderr, /^error: no run is running$/m);
  const again = lfm('abort', '--run', String(run.id));
  assert.equal(again.status, 2, again.stderr);
  assert.match(again.stderr, new RegExp(`^error: run ${run.id} is not running \\(cancelled\\)$`, 'm'));

  // A plain rerun starts a new run with the current config and names the run it started from; the cancelled run stays as it was.
  const rerun = lfm('rerun', '--run', String(run.id), '--wait', '1m', '--json');
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stderr, new RegExp(`^rerun: started run ${run.id + 1} from run ${run.id}$`, 'm'));
  const r = JSON.parse(rerun.stdout);
  assert.deepEqual([r.run.id, r.from], [run.id + 1, run.id]);
  assert.deepEqual([r.run.status, ...r.steps.map((s) => s.status)], Array(13).fill('completed'));
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout).runs.map((x) => x.status), ['completed', 'cancelled', 'completed']);
});

// A copy of the examples with two defect records today, whose PATH holds only the fake agents, node for its #! line, and
// git: lfm(env, ...args) runs the CLI there, query reads the run store, calls(name) an agent's calls, lines(step, run) a step's log lines.
function agentSetup() {
  const { p, env, tmp } = setup();
  const bin = join(p, '..', 'bin'), log = join(p, '..', 'log');
  for (const d of [bin, log]) mkdirSync(d);
  for (const name of ['claude', 'codex']) symlinkSync(FAKE_AGENT, join(bin, name)); // the worker and the judge
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(bin, 'git'));
  appendFileSync(join(p, 'defects.md'), `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [tests] Umer's tests failed: UMER_FIXTURES was unset.\n- [tests] They failed again for the same reason.\n`);
  // The tool's git runs with PATH=bin only, so the host's global git config must not answer: a global hooksPath would
  // run hooks whose bash is not on that PATH, and a ref update (apply's git branch) would fail for the host, not the tool.
  const lfmAt = (dir, extra, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8', env: { ...env, PATH: bin, FAKE_LOG: log, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra } });
  const lfm = (extra, ...args) => lfmAt(p, extra, ...args);
  const query = (sql, ...args) => { const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(...args).map((x) => ({ ...x })); } finally { db.close(); } };
  const calls = (name = 'claude') => readFileSync(join(log, `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lines = (step, id) => JSON.parse(lfm({}, 'logs', '--step', step, '--run', String(id), '--json').stdout).log.map((l) => l.line);
  return { p, env, bin, tmp, lfm, lfmAt, query, calls, lines };
}
// True when a run stored no verdict, label, finding, fix or follow-up, and wrote no report.txt.
function nothingJudged(query, id) {
  return ['labels', 'findings', 'proposals', 'followups'].every((t) => query(`SELECT count(*) AS n FROM ${t} WHERE run_id = ?`, id)[0].n === 0)
    && query(`SELECT count(*) AS n FROM steps WHERE run_id = ? AND name IN ('followup', 'analyse', 'verify', 'propose', 'verify-fixes', 'check', 'report') AND output_json IS NOT NULL`, id)[0].n === 0;
}
// A run's report.txt: the seven sections in order; each line a person reads has sentences of at most 20 words and no
// path or store id; each pointer on an Evidence line opens: a line of a project file, a gate store row or a session.
function reportOf(p, id) {
  const text = readFileSync(join(p, '.lfm', 'runs', String(id), 'report.txt'), 'utf8');
  const heads = text.split('\n').filter((l) => /^\d\. [A-Z][a-z ]+$/.test(l));
  assert.deepEqual(heads, ['1. Short answer', '2. Numbers', '3. Last changes', '4. Repeated mistakes', '5. Fixes', '6. Not checked', '7. Questions for you']);
  // The retro method, pinned: a trend on every number and, under every repeated mistake, its cost, root cause and fix.
  const section = (n) => text.split(/^\d\. .+$/m)[n].split('\n').filter(Boolean);
  for (const line of section(2).filter((l) => /^- [\w:.-]+: this window /.test(l))) assert.match(line, /, last window \S+, trend (?:up|down|flat|unknown),/, line);
  const mistakes = section(4).reduce((acc, l) => (/^- \S+: \d+ times? on /.test(l) ? [...acc, [l]] : l.startsWith('   ') ? [...acc.slice(0, -1), [...acc.at(-1), l]] : acc), []);
  for (const m of mistakes) for (const need of ['Cost: ', 'Root cause: ', 'Fix: ', 'Evidence: ']) assert.ok(m.some((l) => l.startsWith(`   ${need}`)), `${m[0]} lacks ${need}`);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true }), gate = new DatabaseSync(join(p, 'gate.sqlite'), { readOnly: true });
  try {
    for (const line of text.split('\n')) {
      const ap = /^ {3}applied: fix \d+:\d+ on branch lfm\/[^\s/]+\/\d+-\d+, commit ([0-9a-f]{12}), ledger (chg-\d+)$/.exec(line); // a fix the run applied: its ledger entry opens
      if (ap) { assert.ok(readFileSync(join(p, '.lfm', 'changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).some((e) => e.id === ap[2] && e.ref.startsWith(ap[1])), line); continue; }
      const ev = /^ {3}Evidence: (.+)$/.exec(line);
      if (!ev) {
        for (const s of line.split(/(?<=[.!?])\s+/)) assert.ok(s.split(/\s+/).filter(Boolean).length <= 20, `more than 20 words: ${s}`);
        assert.doesNotMatch(line, /\.md\b|sqlite|step_results|session |\/(home|tmp)\/|\be\d+\b|\bstep-\d/, line);
        continue;
      }
      for (const ptr of ev[1].split('; ').filter((x) => !/^and \d+ more$/.test(x))) {
        const file = /^([^\s:]+):(\d+)$/.exec(ptr), row = /^(\S+) step_results row (\S+)$/.exec(ptr), session = /^session (\S+) at (\S+)$/.exec(ptr);
        if (file) assert.ok(readFileSync(join(p, file[1]), 'utf8').split('\n')[file[2] - 1]?.trim(), ptr);
        else if (row) assert.ok(row[1] === 'gate.sqlite' && gate.prepare('SELECT 1 FROM step_results WHERE id = ?').get(row[2]), ptr);
        else assert.ok(session && db.prepare('SELECT 1 FROM events WHERE run_id = ? AND session_id = ? AND ts = ?').get(id, session[1], session[2]), ptr);
      }
    }
  } finally { db.close(); gate.close(); }
  return text;
}

test('analyse: the worker labels the bundle\'s records and names findings; a ref to no bundle item is a problem; bad JSON twice fails the step; a crash leaves no agent', async () => {
  const { p, env, bin, lfm, query, calls, lines: stepLines } = agentSetup();
  const global = join(env.LFM_HOME, 'config.yaml'); // the user set agent: claude and its model there; the run never picks one
  const lines = (id) => stepLines('analyse', id);

  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock' }, 'retro', '--wait', '1m', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run, steps, result } = JSON.parse(r.stdout);
  assert.deepEqual(steps.map((s) => [s.name, s.status]).slice(3), [['bundle', 'completed'], ['analyse', 'completed'], ['verify', 'completed'], ['context', 'completed'], ['propose', 'completed'], ['verify-fixes', 'completed'], ['check', 'completed'], ['apply', 'completed'], ['report', 'completed']]);
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(run.id), 'bundle.md'), 'utf8');
  const records = [...bundle.matchAll(/^- \[([^\]]+)\] log at /gm)].map((m) => m[1]);
  assert.equal(records.length, 2);
  // The worker got the marker, then the prompt with the configured causes, then the bundle, on stdin, in the run dir, tools off.
  const [call] = calls();
  assert.equal(realpathSync(call.cwd), realpathSync(join(p, '.lfm', 'runs', String(run.id))));
  assert.deepEqual(call.args, ['-p', '--output-format', 'json', '--model', MODELS.claude[0], '--tools', '', '--no-session-persistence', '--strict-mcp-config']);
  assert.ok(call.stdin.startsWith(`lfm-run:${run.id}:analyse\nYou are the worker of a retro.`), call.stdin.slice(0, 200));
  assert.match(call.stdin, /^- shared-cache-lock: Workers share one cache/m);
  assert.ok(call.stdin.endsWith(`\n\n${bundle}`), 'the bundle is not the end of the prompt');
  // Its labels and findings land in the tables; the finding with a ref to no bundle item is a counted problem, not kept.
  assert.deepEqual(query('SELECT record_id, event, cause, why FROM labels WHERE run_id = ? ORDER BY record_id', run.id),
    records.toSorted().map((record_id) => ({ record_id, event: 1, cause: 'shared-cache-lock', why: 'The run failed for Umer.' })));
  assert.deepEqual(query('SELECT cause, summary, refs_json FROM findings WHERE run_id = ?', run.id),
    [{ cause: 'umer-fixtures-unset', summary: 'The tests fail when UMER_FIXTURES is unset. No doc names it.', refs_json: JSON.stringify([bundle.match(/^(?:### |- )\[([^\]]+)\]/m)[1]]) }]);
  const [inv] = query('SELECT * FROM invocations WHERE run_id = ?', run.id);
  assert.ok(inv.child_pgid > 0 && inv.completed_at >= inv.started_at, JSON.stringify(inv));
  assert.deepEqual([inv.step, inv.role, inv.runner, inv.model, inv.marker, inv.exit_status, inv.session_id, inv.tokens_in, inv.tokens_out],
    ['analyse', 'worker', 'claude', MODELS.claude[0], `lfm-run:${run.id}:analyse`, 'ok', 'fake-session', 12, 5]);
  assert.deepEqual(lines(run.id), [`worker claude ${MODELS.claude[0]}: answered, 12 tokens in, 5 out`, 'problem: findings[1]: ref 2 names no bundle item',
    'labels: 2 of 2 records, 0 dropped, findings: 1, problems: 1']);
  assert.deepEqual(JSON.parse(query(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'analyse'`, run.id)[0].output_json), { asked: true, labels: 2, labels_dropped: 0, findings: 1, findings_style: 0, problems: 1 });
  const report = JSON.parse(query(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'report'`, run.id)[0].output_json);
  assert.equal(report.coverage.labelled, 2);
  assert.deepEqual(report.causes.filter((c) => c.log.incidents).map((c) => [c.cause, c.log.incidents]), [['shared-cache-lock', 2]]);
  // retro --wait shows the result: the counted causes and the worker's findings, each one line; then where the evidence is.
  const finding = { cause: 'umer-fixtures-unset', count: 1, days: 1, verdict: 'confirmed' };
  assert.deepEqual(result, { summary: 'repeated: agent-exit-wait (4 times/3 days)', labelled: 2, records: 20, causes: [{ cause: 'agent-exit-wait', repeated: true, incidents: 0, days: 0, rows: 4 }, { cause: 'shared-cache-lock', repeated: false, incidents: 2, days: 1, rows: 0 }], findings: [finding] });
  assert.match(lfm({}, 'status').stdout, /^ {2}findings\[1\]\{cause,count,days,verdict\}:\n {4}umer-fixtures-unset,1,1,confirmed$/m);
  assert.match(reportOf(p, run.id), /^5\. Fixes\n- No fix passed the rules\.$/m);
  assert.match(r.stderr, /^next: learn-from-mistakes-axi report --full   # the evidence ids/m);
  // The bare report counts the run's labels and names their source; the findings show as counts, their summaries in status only.
  const bare = lfm({}, 'report', '--json');
  assert.equal(bare.status, 0, bare.stderr);
  const bareJson = JSON.parse(bare.stdout);
  // lfm-report.v2 names the run, its numbers and fixes, and the path of report.txt, never its text.
  assert.deepEqual([bareJson.run, bareJson.report_txt, bareJson.fixes, bareJson.metrics.length > 0], [run.id, join(p, '.lfm', 'runs', String(run.id), 'report.txt'), [], true]);
  assert.deepEqual(bareJson.metrics.find((m) => m.name === 'defects'), JSON.parse(lfm({}, 'status', '--json').stdout).metrics.find((m) => m.name === 'defects'));
  assert.doesNotMatch(bare.stdout, /Retro report|Short answer/);
  assert.deepEqual([bareJson.coverage.labelled, bareJson.causes[1].cause, bareJson.causes[1].log.incidents, bareJson.findings], [2, 'shared-cache-lock', 2, [{ cause: finding.cause, count: 1, days: 1, verdict: 'confirmed' }]]);
  assert.doesNotMatch(bare.stdout, /UMER_FIXTURES|failed for Umer/);
  assert.match(bare.stderr, new RegExp(`^next: learn-from-mistakes-axi status --run ${run.id}   # the run and its steps`, 'm'));
  const toon = lfm({}, 'report');
  assert.equal(toon.status, 0, toon.stderr);
  assert.ok(toon.stdout.split('\n').includes(`finding: ${finding.cause} (1/1 days, confirmed)`), toon.stdout);
  // The bare command: the last run's status and its summary line, then where its report is.
  const last = lfm({});
  assert.equal(last.status, 0, last.stderr);
  const { id, status, created_at, updated_at } = JSON.parse(lfm({}, 'status', '--json').stdout).run;
  assert.deepEqual(decode(last.stdout), { run: { id, status, created_at, updated_at }, summary: result.summary });
  assert.match(last.stderr, /^next: learn-from-mistakes-axi report   # its ids, counts, metrics, verdicts and the path of report\.txt/m);
  // A worker that was asked keeps none of its labels: the report counts none.
  const kept = lfm({ FAKE_ANALYSE: 'outside' }, 'retro', '--foreground', '--json');
  assert.equal(kept.status, 0, kept.stderr);
  const outside = JSON.parse(kept.stdout).run.id;
  assert.deepEqual(lines(outside).slice(-2), ['problem: labels[0] names no defect record in the bundle', 'labels: 0 of 2 records, 1 dropped, findings: 0, problems: 1']);
  assert.equal(JSON.parse(query(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'report'`, outside)[0].output_json).coverage.labelled, 0);
  const shown = lfm({}, 'report');
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stderr, new RegExp(`^note: run ${outside} kept no label and no finding; showing run ${run.id}$`, 'm'));
  // Bad JSON twice: the answer goes back once with the validation error, then the step fails with it.
  const bad = lfm({ FAKE_ANALYSE: 'prose' }, 'retro', '--foreground', '--json');
  assert.equal(bad.status, 1, bad.stderr);
  const b = JSON.parse(bad.stdout);
  const why = "the worker's answer is not valid after one retry: the answer holds no JSON object";
  assert.equal(b.run.error, `analyse: ${why}`);
  // A failed worker leaves nothing verdict-shaped: the followup step's verdicts go too, and it is pending again for a resume.
  assert.deepEqual(b.steps.map((s) => s.status), ['completed', 'completed', 'pending', 'pending', 'failed', ...Array(7).fill('pending')]);
  assert.equal(nothingJudged(query, b.run.id), true);
  assert.match(bad.stderr, new RegExp(`^next: learn-from-mistakes-axi rerun --resume --run ${b.run.id}   # finish it after fixing the analyse step`, 'm'));
  const failed = lfm({}); // the bare command shows the failed run without its error text, which can hold an agent's output
  // A failed run is exit 1 for the bare command, status and status --run alike: the same code retro --wait uses.
  assert.deepEqual([failed.status, decode(failed.stdout).run.status, 'error' in decode(failed.stdout).run, failed.stderr.includes(why)], [1, 'failed', false, false]);
  assert.equal(lfm({}, 'status').status, 1);
  assert.equal(lfm({}, 'status', '--run', String(b.run.id)).status, 1);
  assert.deepEqual(lines(b.run.id).slice(1), ['worker answer 1 is not valid: the answer holds no JSON object', `worker claude ${MODELS.claude[0]}: answered, 12 tokens in, 5 out`,
    'worker answer 2 is not valid: the answer holds no JSON object', `error: ${why}`]);
  assert.match(calls().at(-1).stdin, /\nYour last answer was not valid: the answer holds no JSON object\. Answer again with one JSON object that fixes this\.\n/);
  assert.deepEqual(query('SELECT exit_status FROM invocations WHERE run_id = ?', b.run.id), [{ exit_status: 'invalid' }, { exit_status: 'invalid' }]);
  // An empty answer is a bad answer too: sent back once, then the step fails with the same line.
  const blank = lfm({ FAKE_ANALYSE: 'blank' }, 'retro', '--foreground', '--json');
  assert.equal(blank.status, 1, blank.stderr);
  const e = JSON.parse(blank.stdout).run;
  assert.equal(e.error, "analyse: the worker's answer is not valid after one retry: the answer is empty");
  assert.deepEqual(query('SELECT exit_status FROM invocations WHERE run_id = ?', e.id), [{ exit_status: 'invalid' }, { exit_status: 'invalid' }]);
  // caps.invocations counts the current attempt only: the discarded attempt's 2 calls never block a resume.
  appendFileSync(join(p, '.learn-from-mistakes.yaml'), 'caps: { invocations: 3 }\n');
  const resumed = lfm({ FAKE_ANALYSE: 'prose' }, 'rerun', '--resume', '--run', String(b.run.id), '--wait', '1m', '--json');
  assert.equal(resumed.status, 1, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).run.error, `analyse: the worker's answer is not valid after one retry: the answer holds no JSON object`);
  assert.equal(query('SELECT count(*) AS n FROM invocations WHERE run_id = ?', b.run.id)[0].n, 4);
  // an attempt still makes no call past the cap.
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8').replace('caps: { invocations: 3 }', 'caps: { invocations: 1 }'));
  const capped = lfm({ FAKE_ANALYSE: 'prose' }, 'rerun', '--resume', '--run', String(b.run.id), '--wait', '1m', '--json');
  assert.equal(capped.status, 1, capped.stderr);
  assert.equal(JSON.parse(capped.stdout).run.error, `analyse: caps.invocations reached: run ${b.run.id} already made 1 agent calls`);
  assert.equal(query('SELECT count(*) AS n FROM invocations WHERE run_id = ?', b.run.id)[0].n, 5);

  // A worker killed during the agent call: status marks the run interrupted and ends the agent's process group.
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8').replace('caps: { invocations: 1 }\n', ''));
  const started = lfm({ FAKE_ANALYSE: 'hang' }, 'retro', '--json');
  assert.equal(started.status, 0, started.stderr);
  const h = JSON.parse(started.stdout).run;
  after(() => { try { process.kill(h.pid, 'SIGKILL'); } catch {} });
  let pgid;
  for (let i = 0; i < 100 && !pgid; i++) { await new Promise((ok) => setTimeout(ok, 200)); try { pgid = existsSync(join(p, '.lfm', 'lfm.sqlite')) && query('SELECT child_pgid FROM invocations WHERE run_id = ?', h.id)[0]?.child_pgid; } catch { /* the store is mid-write: read it again */ } }
  assert.ok(pgid, 'the agent call never started');
  after(() => { try { process.kill(-pgid, 'SIGKILL'); } catch {} });
  process.kill(h.pid, 'SIGKILL');
  for (let i = 0; i < 50 && (await statusJson(() => lfm({}, 'status', '--json'))).run.status === 'running'; i++) await new Promise((ok) => setTimeout(ok, 100));
  const k = JSON.parse(lfm({}, 'status', '--json').stdout);
  assert.deepEqual([k.run.status, k.run.error], ['interrupted', 'analyse: the worker stopped before the step ended']);
  assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' }, 'the agent outlived the run');
  assert.deepEqual(query('SELECT exit_status FROM invocations WHERE run_id = ?', h.id), [{ exit_status: 'interrupted' }]);

  // A worker that is not set, or set to an agent that is not ready, stops the retro before any run, with the fix: the run
  // never picks one and never goes on without it.
  const nobin = join(p, '..', 'nobin');
  mkdirSync(nobin);
  symlinkSync(process.execPath, join(nobin, 'node'));
  symlinkSync(join(bin, 'git'), join(nobin, 'git'));
  symlinkSync(FAKE_AGENT, join(nobin, 'codex')); // a ready judge; claude is missing, the worker's problem
  const fix = `ask the user which agent and model to use, then set agent and its agent_config model in ${global}; the run never picks one`;
  const runs = query('SELECT count(*) AS n FROM runs')[0].n, set = readFileSync(global, 'utf8');
  const missing = lfm({ PATH: nobin }, 'retro', '--foreground', '--json');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /^error: worker: .*claude.*$/m);
  assert.ok(missing.stderr.includes(`next: install claude, or ${fix}`), missing.stderr);
  assert.equal(query('SELECT count(*) AS n FROM runs')[0].n, runs);
  writeFileSync(global, set.replace(/^agent: .*\n/m, '')); // the worker not set: the retro asks before any run or agent call
  const unset = lfm({}, 'retro', '--foreground', '--json');
  assert.equal(unset.status, 2, unset.stderr);
  assert.match(unset.stderr, /^error: ask the user which agent to use: agent is not set in /m);
  assert.equal(query('SELECT count(*) AS n FROM runs')[0].n, runs);
  writeFileSync(global, set);

  // An open invocation whose group leader is not the stored process is not signalled when its run ends.
  const decoy = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  let decoyExited = false;
  decoy.on('exit', () => { decoyExited = true; });
  after(() => { try { process.kill(-decoy.pid, 'SIGKILL'); } catch {} });
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.prepare(`INSERT INTO invocations (run_id, step, role, runner, model, marker, started_at, child_pgid, child_started_at) VALUES (?, 'analyse', 'worker', 'claude', 'm', 'x', ?, ?, 'reused')`)
    .run(h.id, new Date().toISOString(), decoy.pid);
  db.prepare(`UPDATE runs SET status = 'running', pid = ?, pid_started_at = 'gone' WHERE id = ?`).run(h.pid, h.id);
  db.close();
  assert.equal(JSON.parse(lfm({}, 'status', '--run', String(h.id), '--json').stdout).run.status, 'interrupted');
  await new Promise((ok) => setTimeout(ok, 300));
  assert.equal(decoyExited, false, 'a group that is not the stored agent was signalled');

  // Run labels that name a record the store no longer has: the report exits 1 and the next step is a new retro.
  const edit = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  edit.prepare(`UPDATE labels SET record_id = record_id || ' gone' WHERE run_id = ?`).run(run.id);
  edit.close();
  const stale = lfm({}, 'report');
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /^problem: /m);
  assert.match(stale.stderr, /^next: learn-from-mistakes-axi retro --wait   # a new run relabels the records/m);
  // The report only reads: a store whose write lock another process holds gives the same report, never a move of it.
  const locked = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  locked.exec('BEGIN IMMEDIATE');
  const busy = lfm({}, 'report');
  locked.exec('ROLLBACK');
  locked.close();
  assert.equal(busy.status, 1, busy.stderr);
  assert.equal(busy.stderr, stale.stderr);
  // One label whose why is still passive after the retry is dropped and counted; the run and its other labels go on.
  const passive = lfm({ FAKE_ANALYSE: 'passive' }, 'retro', '--foreground', '--json');
  assert.equal(passive.status, 0, passive.stderr);
  const pid = JSON.parse(passive.stdout).run.id;
  assert.match(lines(pid).join('\n'), /^problem: labels\[0\] has a why that breaks the plain-language rules$/m);
  assert.equal(query('SELECT count(*) AS n FROM labels WHERE run_id = ?', pid)[0].n, 1);
  assert.match(lines(pid).join('\n'), /^problem: findings\[0\]\.summary: sentence 2 is passive/m); // its finding has one passive summary sentence: kept, with the miss named
  assert.equal(query('SELECT count(*) AS n FROM findings WHERE run_id = ?', pid)[0].n, 1);
  // A store sqlite cannot read is one error line with the file to move, never a stack trace.
  writeFileSync(join(p, '.lfm', 'lfm.sqlite'), 'not a database');
  const broken = lfm({}, 'report');
  assert.equal(broken.status, 2, broken.stderr);
  assert.match(broken.stderr, /^error: .*lfm\.sqlite: not a usable run store/m);
  assert.match(broken.stderr, /^next: mv .*lfm\.sqlite <elsewhere>/m);
  assert.doesNotMatch(broken.stderr, /^\s+at /m);

});

test('propose, verify and check: the judge refutes fix 2 and weakens fix 3; check drops fix 2 and ranks fix 3 last of the five kept; a cause that did not repeat and no tripwire are problems; --proposal copies a fix into the ledger', () => {
  const { p, lfm, query, calls, lines } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_REFUTE: 'p2', FAKE_WEAKEN: 'p3' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run, fixes } = JSON.parse(r.stdout);
  // The judge is the second fake agent (codex, its own model), never the worker: in the run dir it got the judge's method,
  // each finding as a claim with its refs before propose, then each fix after it, each time with the bundle. Its verdicts land on the rows.
  const [judge, fixJudge] = calls('codex');
  assert.equal(realpathSync(judge.cwd), realpathSync(join(p, '.lfm', 'runs', String(run.id))));
  assert.deepEqual(judge.args.slice(0, 3), ['exec', '-m', 'gpt-6-luna']);
  assert.ok(judge.stdin.startsWith(`lfm-run:${run.id}:verify\nYou are the judge of a retro.`), judge.stdin.slice(0, 200));
  assert.ok(fixJudge.stdin.startsWith(`lfm-run:${run.id}:verify-fixes\nYou are the judge of a retro.`), fixJudge.stdin.slice(0, 200));
  assert.match(judge.stdin, /The worker's claims are not evidence\./);
  assert.match(judge.stdin, /^- f1: finding for cause umer-fixtures-unset\. The tests fail when UMER_FIXTURES is unset\. No doc names it\. Why chain: 1\. The run failed\. 2\. The setup step skipped a variable\. 3\. No check names the variable\. Cost: Three runs failed\. Refs: \S+\.$/m);
  assert.doesNotMatch(judge.stdin, /^- p\d+: /m);
  assert.match(fixJudge.stdin, /^- p2: fix for cause shared-cache-lock\. Target: launch script 2\. Owner: maintainer\. Change: .+ Metric: cause_count:shared-cache-lock\. Tripwire: <= 0\. Refs: .+\.$/m);
  assert.doesNotMatch(fixJudge.stdin, /^- f\d+: /m);
  for (const c of [judge, fixJudge]) assert.ok(c.stdin.endsWith(readFileSync(join(p, '.lfm', 'runs', String(run.id), 'bundle.md'), 'utf8')), 'the bundle is not the end of the prompt');
  assert.ok(!calls().some((c) => /:verify(-fixes)?\n/.test(c.stdin)), 'the worker was asked to judge');
  assert.deepEqual(query(`SELECT step, role, runner, model, exit_status FROM invocations WHERE run_id = ? AND step LIKE 'verify%' ORDER BY id`, run.id),
    ['verify', 'verify-fixes'].map((step) => ({ step, role: 'judge', runner: 'codex', model: 'gpt-6-luna', exit_status: 'ok' })));
  assert.deepEqual(query('SELECT verdict, judge_note FROM findings WHERE run_id = ?', run.id), [{ verdict: 'confirmed', judge_note: 'The cited items show this for Umer.' }]);
  assert.deepEqual(query('SELECT verdict FROM proposals WHERE run_id = ? ORDER BY id', run.id).map((f) => f.verdict), ['confirmed', 'refuted', 'weakened', ...Array(5).fill('confirmed')]);
  assert.deepEqual(lines('verify', run.id), ['judge codex gpt-6-luna: answered', 'verdicts: 1 confirmed, 0 weakened, 0 refuted']);
  assert.deepEqual(lines('verify-fixes', run.id), ['judge codex gpt-6-luna: answered', 'refuted: p2', 'weakened: p3', 'verdicts: 6 confirmed, 1 weakened, 1 refuted']);
  // The worker got the causes with their counts, the judged finding and the propose method, then the bundle.
  const call = calls().at(-1);
  assert.ok(call.stdin.startsWith(`lfm-run:${run.id}:propose\nYou are the worker of a retro.`), call.stdin.slice(0, 200));
  assert.match(call.stdin, /^- shared-cache-lock: 2 incidents on 1 day, repeated$/m);
  assert.match(call.stdin, /^- umer-fixtures-unset: 1 incident on 1 day, did not repeat$/m);
  assert.match(call.stdin, /Prefer a check, a script or a deleted rule over more prose\./);
  assert.match(call.stdin, /^Follow-ups to explain:\nNone\.$/m);
  // Five fixes follow the rules: the one whose metric misses its target ranks first, the weakened one last; the refuted one is a problem.
  assert.deepEqual(lines('propose', run.id).slice(1), ['fixes: 8 proposed, reasons: 0 of 0 follow-ups']);
  assert.deepEqual(lines('check', run.id), ['problem: proposals[1]: the judge refuted it', 'problem: proposals[6]: its cause did not repeat; propose only for repeated causes',
    'problem: proposals[7]: no tripwire', 'fixes: 5 kept of 8, problems: 3']);
  assert.deepEqual(query('SELECT n, target, metric, tripwire, problem IS NOT NULL AS problem FROM proposals WHERE run_id = ? ORDER BY id', run.id).map((f) => [f.n, f.target, f.metric, f.tripwire, f.problem]), [
    [2, 'launch script 1', 'cause_count:shared-cache-lock', '<= 0', 0], [null, 'launch script 2', 'cause_count:shared-cache-lock', '<= 0', 1], [5, 'launch script 3', 'cause_count:shared-cache-lock', '<= 0', 0],
    [3, 'launch script 4', 'cause_count:shared-cache-lock', '<= 0', 0], [4, 'launch script 5', 'cause_count:shared-cache-lock', '<= 0', 0], [1, 'launch script 6', 'defects', '<= 0', 0],
    [null, 'test setup', 'defects', '<= 0', 1], [null, 'cache config', 'cause_count:shared-cache-lock', null, 1]]);
  assert.deepEqual(fixes, [1, 2, 3, 4, 5].map((n) => ({ n, cause: 'shared-cache-lock', metric: n === 1 ? 'defects' : 'cause_count:shared-cache-lock', tripwire: '<= 0', verdict: n === 5 ? 'weakened' : 'confirmed' })));
  assert.deepEqual(query('SELECT cause, count, days FROM findings WHERE run_id = ?', run.id), [{ cause: 'umer-fixtures-unset', count: 1, days: 1 }]);
  // report.txt: the kept fixes with the judge's verdict and note, what was not checked, and with no sign-off-axi an Apply or Skip question per fix.
  const text = reportOf(p, run.id);
  assert.match(text, /^- 2 mistakes came back in this window\.\n- 5 fixes passed the rules\. The judge confirmed 4 of them\.\n- 1 metric missed the target\.$/m);
  assert.match(text, /^- defects: this window 2, last window 0, trend up, target <= 0, missed\.$/m);
  assert.match(text, /^- shared-cache-lock: 2 times on 1 day\.\n {3}Cost: No finding gave a cost\.\n {3}Root cause: No finding gave a root cause\.\n {3}Fix: see fix 1, 2, 3, 4, 5 in section 5\.\n {3}Evidence: defects\.md:\d+; defects\.md:\d+$/m);
  assert.match(text, /^Fix 5, for shared-cache-lock:\n[\s\S]*?^- Change:\n {2}Give each worker its own cache directory\.\n[\s\S]*?^- The judge's verdict: weakened\.\n {2}The cited items show this only once for Umer\.$/m);
  assert.match(text, /^6\. Not checked\n- No finding cites 1 defect record\.\n {3}Evidence: defects\.md:30\n {3}Text: \[tests\] They failed again for the same reason\.\n- The rules left out 3 fixes\.\n {3}The fix for shared-cache-lock: the judge refuted it\.\n {3}The fix for umer-fixtures-unset: its cause did not repeat; propose only for repeated causes\.\n {3}The fix for shared-cache-lock: no tripwire\.\n- The judge weakened 1 item\.$/m);
  assert.deepEqual(text.split('\n').filter((l) => /^\d\. Apply/.test(l)), [1, 2, 3, 4, 5].map((n) => `${n}. Apply fix ${n}, for shared-cache-lock? Answer Apply or Skip.`));
  assert.match(lines('report', run.id).at(-1), /^report\.txt: \d+ lines, 5 questions$/);

  // Explicit sign-off handoff: absent peer prints kept fix keys only (R1: ids, counts, verdicts), a peer gets only contract-v1 fields.
  assert.deepEqual(query('SELECT DISTINCT kind FROM proposals WHERE run_id = ?', run.id), [{ kind: 'code' }]);
  const fallback = lfm({}, 'signoff', 'post');
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /kept: lfm-\d+-\d+-[0-9a-f]{8}[\s\S]*npm i -g sign-off-axi[\s\S]*report\.txt/);
  assert.ok(!fallback.stdout.includes('Repeated cause:'));
  assert.ok(!fallback.stdout.includes('2 incidents over 1 days.'));
  assert.ok(!fallback.stdout.includes('Give each worker its own cache directory'));
  assert.ok(!fallback.stdout.includes('UMER_FIXTURES'));
  const signDir = join(p, '..', 'signoff'); mkdirSync(signDir);
  const signBin = join(p, '..', 'bin', 'sign-off-axi');
  symlinkSync(new URL('./fake-agent/sign-off-axi', import.meta.url).pathname, signBin);
  const peerEnv = { FAKE_SIGNOFF_DIR: signDir };
  const edit = (sql, ...args) => { const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite')); try { db.prepare(sql).run(...args); } finally { db.close(); } };
  edit('UPDATE proposals SET kind = NULL WHERE run_id = ? AND n = 1', run.id);
  const noKind = lfm(peerEnv, 'signoff', 'post');
  assert.equal(noKind.status, 2); assert.match(noKind.stderr, /next: learn-from-mistakes-axi retro/);
  edit("UPDATE proposals SET kind = CASE n WHEN 1 THEN 'doc' WHEN 2 THEN 'rule' ELSE 'code' END WHERE run_id = ?", run.id);
  edit("UPDATE proposals SET change = ? WHERE run_id = ? AND n = 1", "x".repeat(501), run.id);
  assert.equal(lfm(peerEnv, 'signoff', 'post').status, 2);
  edit("UPDATE proposals SET change = ? WHERE run_id = ? AND n = 1", "Give each worker its own cache directory with token=s3cret-value-123.", run.id);
  const extraRefs = Array.from({ length: 60 }, (_, k) => `lab:${k}`);
  for (const ref of extraRefs) edit("INSERT INTO records (run_id, source, ref, text, record_id) VALUES (?, 'lab', 'synthetic', 'PRIVATE-CANARY-Umer', ?)", run.id, ref);
  edit("UPDATE proposals SET refs_json = ? WHERE run_id = ? AND n = 1", JSON.stringify(extraRefs), run.id);
  const refusedFirst = lfm({ ...peerEnv, FAKE_SIGNOFF_REFUSE: '1' }, 'signoff', 'post', '--run', String(run.id));
  assert.equal(refusedFirst.status, 2);
  assert.equal(query('SELECT count(*) AS n FROM signoff')[0].n, 0, 'a refused message is not frozen');
  const post = lfm(peerEnv, 'signoff', 'post', '--run', String(run.id));
  assert.equal(post.status, 0, post.stderr);
  const boardFile = join(signDir, 'board.json'), firstBoard = readFileSync(boardFile, 'utf8'), board = JSON.parse(firstBoard);
  assert.equal(board.length, 5);
  assert.equal(board[0].evidence_ids.length, 50);
  assert.equal(board[0].proposal, 'Give each worker its own cache directory with token=[redacted]');
  for (const ref of board[0].evidence_ids) assert.match(ref, /^rec-\d+$/);
  for (const m of board) {
    assert.deepEqual(Object.keys(m).sort(), ['contract', 'kind', 'schema', 'key', 'title', 'filer', 'about', 'cause', 'incidents', 'days', 'evidence_ids', 'change_kind', 'proposal', 'options', 'recommend_value'].sort());
    assert.deepEqual([m.contract, m.kind, m.schema, m.filer, m.change_kind, m.recommend_value], [1, 'finding', 1, 'learn-from-mistakes', ['doc', 'rule', 'code', 'code', 'code'][board.indexOf(m)], 'apply']);
    for (const [field, max] of [['title', 160], ['about', 500], ['proposal', 500]]) {
      assert.ok(m[field].trim() && [...m[field]].length <= max && !/[\p{Cc}\p{Cf}]/u.test(m[field].replaceAll('\n', '')));
    }
    assert.match(m.key, /^[A-Za-z0-9._-]{1,128}$/); assert.match(m.cause, /^[a-z0-9-]{1,64}$/);
    assert.deepEqual([m.incidents, m.days, m.about], [2, 1, '2 incidents over 1 days.']);
    for (const n of [m.incidents, m.days]) assert.ok(Number.isSafeInteger(n) && n >= 0);
    assert.ok(m.evidence_ids.length <= 50 && new Set(m.evidence_ids).size === m.evidence_ids.length);
    for (const ref of m.evidence_ids) assert.match(ref, /^[A-Za-z0-9._-]{1,128}$/);
    assert.deepEqual(m.options, [{ value: 'apply', label: 'Apply' }, { value: 'skip', label: 'Skip' }]);
    for (const { text } of query('SELECT text FROM records WHERE run_id = ?', run.id)) if (text) assert.ok(!JSON.stringify(m).includes(text));
  }
  // Frozen messages survive config/source changes; posting twice is a board no-op.
  edit("UPDATE records SET text = 'PRIVATE-CANARY-Umer' WHERE run_id = ?", run.id);
  assert.equal(lfm(peerEnv, 'signoff', 'post').status, 0);
  assert.equal(readFileSync(boardFile, 'utf8'), firstBoard);
  const refused = lfm({ ...peerEnv, FAKE_SIGNOFF_REFUSE: '1' }, 'signoff', 'post');
  assert.equal(refused.status, 2); assert.match(refused.stderr, /VALIDATION_ERROR[\s\S]*help\[1\][\s\S]*next:/);
  const postCalls = readFileSync(join(signDir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(postCalls.length, 12, 'a refusal stops before the second finding');
  for (const c of postCalls) assert.deepEqual(c.args, ['post', '--kind', 'finding', '--from', '-']);
  assert.deepEqual(postCalls.slice(1, 6).map((c) => c.stdin), postCalls.slice(6, 11).map((c) => c.stdin));
  const reply = (...items) => writeFileSync(join(signDir, 'answers.json'), JSON.stringify(Object.assign({}, ...items.map(([key, answer]) =>
    ({ [key]: { answer, label: answer === 'apply' ? 'Apply' : 'Skip', close: 'done', at: '2026-10-13T22:00:52Z' } })))));
  const stored = (n) => query('SELECT answer FROM signoff WHERE proposal_id = (SELECT id FROM proposals WHERE run_id = ? AND n = ?)', run.id, n)[0].answer;
  reply([board[0].key, 'apply'], [board[1].key, 'skip'], ['another-filer', 'yes']);
  assert.equal(lfm(peerEnv, 'signoff', 'answers').status, 0);
  assert.deepEqual(query('SELECT answer FROM signoff ORDER BY proposal_id').map((r) => r.answer).filter(Boolean).sort(), ['apply', 'skip']);
  const taken = lfm(peerEnv, 'signoff', 'answers');
  assert.equal(taken.status, 0, taken.stderr);
  assert.match(taken.stdout, /No new answers for posted findings\./);
  assert.deepEqual(JSON.parse(readFileSync(join(signDir, 'calls.jsonl'), 'utf8').trim().split('\n').at(-1)).args, ['wait', '--filer', 'learn-from-mistakes', '--timeout', '1', '--json']);
  reply([board[0].key, 'skip'], [board[1].key, 'yes']);
  const unknown = lfm(peerEnv, 'signoff', 'answers');
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(unknown.stderr, new RegExp(`${board[1].key} answer is not apply or skip`));
  assert.equal(stored(1), 'skip');
  assert.ok(!existsSync(join(p, '.lfm', 'changes.jsonl')), 'reading answers must not apply a change');
  assert.equal(query('SELECT count(*) AS n FROM signoff').at(0).n, 5);
  reply([board[0].key, 'apply']);
  assert.match(lfm(peerEnv, 'signoff', 'answers').stdout, new RegExp(`saved: ${board[0].key} apply`));
  assert.equal(stored(1), 'apply');
  const unkept = query('SELECT s.proposal_id, s.message FROM signoff s JOIN proposals p ON p.id = s.proposal_id WHERE s.answer IS NULL')[0], unkeptKey = JSON.parse(unkept.message).key;
  const writeDb = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite')); writeDb.prepare('UPDATE proposals SET n = NULL WHERE id = ?').run(unkept.proposal_id); writeDb.close(); reply([unkeptKey, 'apply']);
  assert.match(lfm(peerEnv, 'signoff', 'answers').stderr, new RegExp(`${unkeptKey} is for a fix that is no longer kept`));
  assert.equal(query('SELECT answer FROM signoff WHERE proposal_id = ?', unkept.proposal_id)[0].answer, null);
  rmSync(join(signDir, 'board.json'));
  const none = lfm(peerEnv, 'signoff', 'answers');
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /No new answers for posted findings\./);
  assert.equal(lfm({ ...peerEnv, FAKE_SIGNOFF_REFUSE: '1' }, 'signoff', 'answers').status, 2);
  // --proposal copies the kept fix's cause, metric and tripwire into the ledger; a fix that was not kept has no number.
  const applied = lfm({}, 'change', 'applied', '--proposal', `${run.id}:1`, '--ref', 'abc1234', '--json');
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual((({ id, cause, metric, tripwire, kind }) => ({ id, cause, metric, tripwire, kind }))(JSON.parse(applied.stdout)),
    { id: 'chg-1', cause: 'shared-cache-lock', metric: 'defects', tripwire: '<= 0', kind: 'doc' });
  const dropped = lfm({}, 'change', 'applied', '--proposal', `${run.id}:6`, '--ref', 'abc1234');
  assert.equal(dropped.status, 2, dropped.stderr);
  assert.match(dropped.stderr, new RegExp(`^error: run ${run.id} has no kept fix 6$`, 'm'));
  const both = lfm({}, 'change', 'applied', '--proposal', `${run.id}:1`, '--cause', 'shared-cache-lock', '--ref', 'abc1234');
  assert.match(both.stderr, /^error: pass --cause or --proposal, not both$/m);

  const posted = () => readFileSync(join(signDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'post').map((c) => JSON.parse(c.stdin));
  const frozen = new Set(board.map((m) => m.key));
  edit("UPDATE runs SET status = 'failed' WHERE id = ?", run.id);
  edit("UPDATE steps SET status = 'failed' WHERE run_id = ? AND name IN ('propose', 'verify', 'check', 'report')", run.id);
  const again = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'long' }, 'rerun', '--resume', '--run', String(run.id), '--wait', '8m');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(reportOf(p, run.id), /^7\. Questions for you\n- Run learn-from-mistakes-axi signoff post\. It sends each fix to sign-off as an Apply or Skip question\.\n$/m);
  const sentBefore = posted().length;
  assert.equal(lfm(peerEnv, 'signoff', 'post', '--run', String(run.id)).status, 0);
  const fresh = posted().slice(sentBefore);
  assert.deepEqual(fresh.map((m) => m.proposal), ['Give each worker its own cache directory.']);
  assert.ok(fresh.every((m) => !frozen.has(m.key)), 'a re-proposed run posts new keys, not the frozen messages');
  rmSync(signBin);
  assert.equal(lfm({}, 'signoff', 'answers').status, 0);
  assert.equal(lfm({}, 'signoff', 'post', '--run', '999').status, 2);

  // The next retro asks the worker why the applied change's verdict is not keep; the reason lands on its follow-up.
  const next = lfm({ FAKE_ANALYSE: 'empty' }, 'retro', '--foreground', '--json');
  assert.equal(next.status, 0, next.stderr);
  const { run: second, followups } = JSON.parse(next.stdout);
  assert.deepEqual(followups.map((f) => [f.change, f.verdict]), [['chg-1', 'no-data']]);
  assert.match(calls().at(-1).stdin, /^Follow-ups to explain:\n- chg-1: metric defects, 2 before, 0 after, tripwire <= 0, verdict no-data$/m);
  assert.deepEqual(query('SELECT change_id, reason FROM followups WHERE run_id = ?', second.id), [{ change_id: 'chg-1', reason: 'Too few sessions ran after the change for Umer.' }]);
  assert.match(reportOf(p, second.id), /^3\. Last changes\n- Change chg-1, metric defects: 2 before, 0 after\. The verdict is no-data\. Wait for more data\.\n {3}Proposal checked: confirmed\. Fix applied: yes\. Fix shipped: yes\. Fix worked: not yet\.\n {3}Check: npm test\n {2}Too few sessions ran after the change for Umer\.\n\n4\.[\s\S]*^7\. Questions for you\n- No questions\.\n$/m);
  assert.deepEqual([lines('verify', second.id), lines('verify-fixes', second.id)], [['nothing to verify: no finding'], ['nothing to verify: no fix']]);
  assert.deepEqual(lines('check', second.id), ['fixes: 0 kept of 0, problems: 0']);
});

// The project's own context: the retro reads the docs, the skills and the code the incidents point at, in a bounded
// way, and a fix of kind rule names the project rule it replaces.
test('the retro reads a bounded project context, and a rule fix names the project rule it replaces', () => {
  const { p, lfm, query, lines } = agentSetup(), yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(join(p, 'AGENTS.md'), '# Rules\n\n- Run the tests before a PR.\n');
  writeFileSync(join(p, 'README.md'), '# Demo project\n\nA small project.\n');
  mkdirSync(join(p, '.agents', 'skills', 'demo'), { recursive: true });
  writeFileSync(join(p, '.agents', 'skills', 'demo', 'SKILL.md'), '# Demo skill\n\nAlways run the tests.\n');
  mkdirSync(join(p, 'src'), { recursive: true });
  writeFileSync(join(p, 'src', 'big.ts'), `// a big file\n${'const x = 1;\n'.repeat(400)}`); // over the character cap
  mkdirSync(join(p, 'deploy'), { recursive: true });
  writeFileSync(join(p, 'deploy', 'app.key'), 'KEY=secret\n'); // a secret file
  appendFileSync(join(p, 'defects.md'), `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [tests] The demo suite failed in src/big.ts and the key deploy/app.key was missing -> lost 5 minutes -> OPEN.\n`);
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }')}context: { max_files: 4, max_chars: 2000 }\n`);
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'context' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const id = JSON.parse(r.stdout).run.id, context = readFileSync(join(p, '.lfm', 'runs', String(id), 'context.md'), 'utf8');
  // The context holds the docs and the skill it read, and the files it did not read, each with the reason.
  assert.match(context, /^### README\.md$/m);
  assert.match(context, /^### AGENTS\.md$/m);
  assert.match(context, /^### \.agents\/skills\/demo\/SKILL\.md$/m);
  assert.match(context, /^- deploy\/app\.key: a secret file is never read$/m);
  assert.match(context, /^- src\/big\.ts: too large for the context cap$/m);
  assert.ok(!context.includes('KEY=secret'), 'a secret file never reaches the context');
  // The report names the context it read and the context it did not read, with the reason.
  const report = reportOf(p, id);
  assert.match(report, /^The run read 3 project files before it proposed these fixes\.\n {3}Evidence: README\.md:1; AGENTS\.md:1; \.agents\/skills\/demo\/SKILL\.md:1$/m);
  assert.match(report, /^- The project context did not read 2 files: 1 held a secret, 1 was too large\.\n {3}Evidence: deploy\/app\.key:1; src\/big\.ts:1$/m);
  // The fix names the project rule it replaces, and the report points at the line that holds it.
  assert.deepEqual(query('SELECT current_rule, rule_ref FROM proposals WHERE run_id = ?', id), [{ current_rule: 'Run the tests before a PR.', rule_ref: 'AGENTS.md' }]);
  assert.match(report, /^- Current rule:\n {2}Run the tests before a PR\.\n {3}Evidence: AGENTS\.md:3$/m);
  // A rule the run did not read is refused: the fix is sent back once and then dropped.
  const bad = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'context', FAKE_RULE_REF: 'notes.md' }, 'retro', '--foreground', '--json');
  assert.equal(bad.status, 0, bad.stderr);
  const other = JSON.parse(bad.stdout).run.id;
  assert.deepEqual(query('SELECT count(*) AS n FROM proposals WHERE run_id = ?', other)[0].n, 0);
  assert.match(lines('propose', other).join('\n'), /rule_ref must name a file the run read/);
  // A fix that changes a file of the project but names no current rule is left out, and the report says so.
  const silent = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'norule' }, 'retro', '--foreground', '--json');
  assert.equal(silent.status, 0, silent.stderr);
  const third = JSON.parse(silent.stdout).run.id;
  assert.deepEqual(query('SELECT n, problem FROM proposals WHERE run_id = ?', third), [{ n: null, problem: 'it names no current project rule' }]);
  assert.match(reportOf(p, third), /^- The rules left out 1 fix\.\n {3}The fix for shared-cache-lock: it names no current project rule\.$/m);
});

test('signoff_report: a run posts its whole report to sign-off when asked, shows the outcome, and a retry adds no card', () => {
  const { p, bin, lfm, query } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml'), base = readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }');
  const fake = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight' };
  const signDir = join(p, '..', 'signoff'); mkdirSync(signDir);
  const peerEnv = { FAKE_SIGNOFF_DIR: signDir };
  const retro = (extra) => { const r = lfm({ ...fake, ...extra }, 'retro', '--foreground', '--json'); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const calls = () => (existsSync(join(signDir, 'calls.jsonl')) ? readFileSync(join(signDir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const board = () => JSON.parse(readFileSync(join(signDir, 'board.json'), 'utf8'));
  // Off by default: no post, no outcome, even with the peer installed.
  writeFileSync(yaml, base);
  symlinkSync(new URL('./fake-agent/sign-off-axi', import.meta.url).pathname, join(bin, 'sign-off-axi'));
  const off = retro(peerEnv);
  assert.equal(off.signoff_report, undefined);
  assert.equal(calls().length, 0, 'the report reached sign-off with signoff_report unset');
  // On, with no peer: the run completes and says in one line that nothing was posted; the command says the same.
  writeFileSync(yaml, `${base}signoff_report: on\n`);
  rmSync(join(bin, 'sign-off-axi'));
  const alone = retro();
  assert.equal(alone.run.status, 'completed');
  assert.deepEqual([alone.signoff_report.state, alone.signoff_report.key], ['skipped', `lfm-report-${alone.run.id}`]);
  assert.match(alone.signoff_report.why, /sign-off-axi is not installed; the report stays in report\.txt/);
  const aloneCmd = lfm({}, 'signoff', 'report');
  assert.equal(aloneCmd.status, 0, aloneCmd.stderr);
  assert.match(aloneCmd.stdout, /^skipped: lfm-report-\d+ \(sign-off-axi is not installed/m);
  // On, with a peer: one report card, no Apply or Skip options, and the outcome in status.
  symlinkSync(new URL('./fake-agent/sign-off-axi', import.meta.url).pathname, join(bin, 'sign-off-axi'));
  const posted = retro(peerEnv);
  assert.deepEqual([posted.run.status, posted.signoff_report.state, posted.signoff_report.why], ['completed', 'posted', null]);
  assert.deepEqual(calls().map((c) => c.args), [['post', '--kind', 'report', '--from', '-']]);
  const [card] = board(), first = readFileSync(join(signDir, 'board.json'), 'utf8');
  assert.equal(board().length, 1);
  assert.deepEqual([card.contract, card.kind, card.schema, card.key, card.filer], [1, 'report', 3, `lfm-report-${posted.run.id}`, 'learn-from-mistakes']);
  assert.ok(!('options' in card) && !JSON.stringify(card).includes('"apply"'), 'the report carries Apply or Skip choices');
  assert.deepEqual([card.purpose, card.project], ['audit', /^Retro for (.*): \d+ repeated/.exec(card.title)[1]], 'a retro is an audit of its project by default');
  assert.ok(card.project && [...card.project].length <= 40);
  assert.match(card.title, /^Retro for .*: 2 repeated mistakes, 5 fixes kept$/);
  assert.deepEqual(card.sections.map((x) => x.id), ['mistakes', 'fixes', 'not-checked']);
  assert.equal(card.sections[1].items.length, 5);
  assert.match(card.sections[1].items[0].more, /Give each worker its own cache directory/);
  assert.deepEqual(JSON.parse(lfm({}, 'status', '--json').stdout).signoff_report, { key: card.key, state: 'posted', why: null });
  // A retry sends the same message again and the board keeps one card with the same bytes.
  const retry = lfm(peerEnv, 'signoff', 'report');
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.stdout.trim(), `posted: ${card.key}`);
  assert.equal(readFileSync(join(signDir, 'board.json'), 'utf8'), first);
  assert.equal(calls().length, 2);
  assert.equal(calls()[0].stdin, calls()[1].stdin);
  // Purpose and project can be set; an unknown purpose is refused before anything is sent.
  const sent = calls().length;
  const bad = lfm(peerEnv, 'signoff', 'report', '--purpose', 'retro');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^error: --purpose "retro" must be one of research, plan, decision, audit, incident, status, other$/m);
  assert.equal(calls().length, sent);
  // The Apply or Skip cards stay a separate command with their own keys.
  assert.equal(lfm(peerEnv, 'signoff', 'post').status, 0);
  assert.equal(board().length, 6);
  assert.deepEqual(board().filter((m) => m.kind === 'finding').length, 5);
  assert.equal(board().filter((m) => m.kind === 'report').length, 1);
  // A peer that refuses the report fails nothing but the post: the run completes, status names the cause, a retry posts.
  const refused = retro({ ...peerEnv, FAKE_SIGNOFF_REFUSE: '1' });
  assert.equal(refused.run.status, 'completed');
  assert.deepEqual([refused.signoff_report.state, refused.signoff_report.key], ['failed', `lfm-report-${refused.run.id}`]);
  assert.match(refused.signoff_report.why, /sign-off-axi: exit 2/);
  assert.equal(board().filter((m) => m.key === refused.signoff_report.key).length, 0);
  const again = lfm(peerEnv, 'signoff', 'report', '--purpose', 'status', '--project', 'sample-project');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(board().filter((m) => m.key === refused.signoff_report.key).map((m) => [m.purpose, m.project]), [['status', 'sample-project']]);
  assert.deepEqual(query('SELECT state, why FROM signoff_report WHERE run_id = ?', refused.run.id), [{ state: 'posted', why: null }]);
  const failedCmd = lfm({ ...peerEnv, FAKE_SIGNOFF_REFUSE: '1' }, 'signoff', 'report', '--run', String(refused.run.id));
  assert.equal(failedCmd.status, 1);
  assert.match(failedCmd.stdout, /^failed: lfm-report-\d+ \(sign-off-axi: exit 2\)$/m);
  assert.equal(lfm(peerEnv, 'signoff', 'report', '--run', '999').status, 2);
});

function applyRepo() {
  const s = agentSetup(), yaml = join(s.p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }')); writeFileSync(join(s.p, 'AGENTS.md'), '# Rules\n\n- Run the tests before a PR.\n');
  s.git = (...args) => execFileSync(join(s.bin, 'git'), ['-C', s.p, ...args], { encoding: 'utf8' }).trim();
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Umer'], ['config', 'user.email', 'umer@example.com'], ['add', '-A'], ['commit', '-qm', 'start']]) s.git(...a);
  s.global = join(s.env.LFM_HOME, 'config.yaml'); s.auto = (v) => writeFileSync(s.global, `${readFileSync(s.global, 'utf8')}auto_fix: ${v}\n`);
  s.fake = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_TARGET: 'AGENTS.md:12 and defects.md' };
  return s;
}

test('apply: the worker makes an accepted fix on its own branch from HEAD and records it; Skip, a dirty tree and no file refuse; auto_fix applies in the run', () => {
  const { p, global, lfm, query, calls, lines, git, fake, auto } = applyRepo();
  const rules = '# Rules\n\n- Run the tests before a PR.\n'; const head = git('rev-parse', 'HEAD');
  const defects = readFileSync(join(p, 'defects.md'), 'utf8');
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  assert.deepEqual(lines('apply', run.id), ['auto_fix: 0, so nothing is applied: answer Apply on a fix, then learn-from-mistakes-axi apply']);
  const asked = (id) => reportOf(p, id).split('\n').filter((l) => /^\d\. Apply|^ {3}applied: /.test(l));
  assert.deepEqual(asked(run.id), [1, 2, 3, 4, 5].map((n) => `${n}. Apply fix ${n}, for shared-cache-lock? Answer Apply or Skip.`)); // auto_fix: 0 asks about every kept fix
  const none = lfm({}, 'apply'); assert.equal(none.status, 3, none.stderr);
  assert.match(none.stderr, new RegExp(`^error: run ${run.id} has no fix answered Apply\nnext: learn-from-mistakes-axi apply --run ${run.id} --fix <n>`, 'm'));
  const missing = lfm({}, 'apply', '--run', '99'); assert.equal(missing.status, 2, missing.stderr); assert.match(missing.stderr, /^error: no run 99$/m);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.prepare(`INSERT INTO signoff (proposal_id, message, answer) SELECT id, '{}', CASE n WHEN 1 THEN 'apply' ELSE 'skip' END FROM proposals WHERE run_id = ? AND n IN (1, 2)`).run(run.id);
  db.prepare(`UPDATE proposals SET target = 'the launch script' WHERE run_id = ? AND n = 3`).run(run.id); db.close();
  writeFileSync(join(p, 'AGENTS.md'), `${rules}\n- Unfinished.\n`);
  const dirty = lfm({}, 'apply'); assert.equal(dirty.status, 1, dirty.stderr);
  assert.match(dirty.stderr, /has uncommitted changes; apply never touches them\nnext: git status/);
  writeFileSync(join(p, 'AGENTS.md'), rules); writeFileSync(join(p, 'notes.txt'), 'Umer is still writing this.\n');
  const before = calls().length, ok = lfm({}, 'apply'); assert.equal(ok.status, 0, ok.stderr);
  const commit = git('rev-parse', `lfm/example-e3b0c4/${run.id}-1`); assert.equal(ok.stdout, `applied: fix ${run.id}:1 on branch lfm/example-e3b0c4/${run.id}-1, commit ${commit.slice(0, 12)}, ledger chg-1\n`);
  assert.match(ok.stderr, new RegExp(`^next: git diff HEAD\\.\\.\\.lfm/example-e3b0c4/${run.id}-1   # review it`, 'm'));
  // The branch holds one commit on HEAD with the worker's edit; the user's branch, index and work tree are untouched.
  assert.deepEqual([git('rev-parse', `lfm/example-e3b0c4/${run.id}-1^`), git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')], [head, head, 'main', '?? notes.txt']);
  rmSync(join(p, 'notes.txt')); assert.equal(readFileSync(join(p, 'AGENTS.md'), 'utf8'), rules);
  assert.equal(git('show', `lfm/example-e3b0c4/${run.id}-1:AGENTS.md`), `${rules}- Give each worker its own cache directory, Umer.`);
  assert.equal(git('show', `lfm/example-e3b0c4/${run.id}-1:defects.md`), `${defects}- Give each worker its own cache directory, Umer.`);
  assert.deepEqual(git('diff', '--name-only', `HEAD..lfm/example-e3b0c4/${run.id}-1`), 'AGENTS.md\ndefects.md');
  // One fresh tool-off call to the worker, never the judge, with the fix and both files: no bundle and no record text beyond the files.
  const call = calls().at(-1); assert.equal(calls().length, before + 1);
  assert.ok(call.stdin.startsWith(`lfm-run:${run.id}:apply-1\nYou are the worker of a retro. The user accepted the fix below.`), call.stdin.slice(0, 200));
  assert.ok(call.args.includes('--tools') && call.stdin.includes(`--- AGENTS.md\n${rules}\n--- end of AGENTS.md`) && call.stdin.includes(`--- defects.md\n${defects}\n--- end of defects.md`) && !call.stdin.includes('# Retro bundle'));
  // The log records live in defects.md, so they arrive with that target file; every other source's record text stays out.
  for (const { text } of query(`SELECT text FROM records WHERE run_id = ? AND source != 'log'`, run.id)) assert.ok(!call.stdin.includes(text.trim()), 'record text reached the apply call');
  assert.ok(!calls('codex').some((c) => c.stdin.includes(':apply-')), 'the judge applied a fix');
  assert.deepEqual(query(`SELECT role, runner, exit_status FROM invocations WHERE run_id = ? AND step = 'apply-1'`, run.id), [{ role: 'worker', runner: 'claude', exit_status: 'ok' }]);
  const [chg] = JSON.parse(lfm({}, 'changes', '--json').stdout).changes; assert.deepEqual([chg.id, chg.cause, chg.ref, chg.kind, chg.what], ['chg-1', 'shared-cache-lock', commit, 'code', `fix ${run.id}:1 on branch lfm/example-e3b0c4/${run.id}-1`]);
  assert.equal(chg.check, 'npm test'); // the worker's check command is recorded with the applied fix
  assert.match(reportOf(p, run.id), /^- Check: npm test$/m);
  assert.equal(lfm({}, 'apply').stdout, ok.stdout); assert.equal(calls().length, before + 1);
  { // a reused run id with the same cause and change text but another target is refused, never reported applied
    const reuse = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
    try { reuse.prepare(`UPDATE proposals SET target = 'defects.md' WHERE run_id = ? AND n = 1`).run(run.id); } finally { reuse.close(); }
    const other = lfm({}, 'apply', '--fix', '1'); assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, new RegExp(`^error: branch lfm/example-e3b0c4/${run.id}-1 holds [0-9a-f]{7} instead of the fix ${run.id}:1 apply commit\nnext: git branch -D lfm/example-e3b0c4/${run.id}-1`, 'm'));
    assert.equal(git('rev-parse', `lfm/example-e3b0c4/${run.id}-1`), commit, 'a refused reuse must not move the branch');
    assert.equal(calls().length, before + 1, 'a refused reuse must not call the worker');
    const restore = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
    try { restore.prepare(`UPDATE proposals SET target = 'AGENTS.md:12 and defects.md' WHERE run_id = ? AND n = 1`).run(run.id); } finally { restore.close(); }
  }
  git('branch', '-f', `lfm/example-e3b0c4/${run.id}-1`, git('commit-tree', `${head}^{tree}`, '-p', head, '-m', `learn-from-mistakes: fix ${run.id}:1 for slow-build\n\nRebuild the Go binary before the gate.`));
  const stale = lfm({}, 'apply', '--fix', '1'); assert.equal(stale.status, 1, stale.stderr); assert.match(stale.stderr, new RegExp(`^error: branch lfm/example-e3b0c4/${run.id}-1 holds [0-9a-f]{7} instead of the fix ${run.id}:1 apply commit\nnext: git branch -D lfm/example-e3b0c4/${run.id}-1`, 'm'));
  for (const [n, code, error] of [[2, 2, `fix ${run.id}:2 was answered Skip, and a Skip is never applied`], [3, 1, `fix ${run.id}:3 names no tracked file in its target "the launch script", so the worker has nothing to edit`], [9, 2, `run ${run.id} has no kept fix 9`]]) {
    const r = lfm({}, 'apply', '--fix', String(n)); assert.equal(r.status, code, r.stderr); assert.match(r.stderr, new RegExp(`^error: ${error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.ok(!git('branch', '--list', 'lfm/*').includes('-2') && JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length === 1);
  auto(-1); assert.match(lfm({}, 'apply').stderr, /auto_fix must be a whole number, 0 or more \(0 = propose only\)/);
  writeFileSync(global, readFileSync(global, 'utf8').replace('auto_fix: -1', 'auto_fix: 1'));
  const auto1 = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout), branch = `lfm/example-e3b0c4/${auto1.run.id}-1`, commit2 = git('rev-parse', branch);
  assert.deepEqual([auto1.run.status, git('rev-parse', `${branch}^`), git('branch', '--show-current'), git('status', '--porcelain')], ['completed', head, 'main', '']);
  assert.deepEqual(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.map((c) => [c.id, c.ref]), [['chg-1', commit], ['chg-2', commit2]]);
  // The run applies fix 1 before its report: report.txt and signoff post name it as applied and ask only about the rest.
  const done = `applied: fix ${auto1.run.id}:1 on branch ${branch}, commit ${commit2.slice(0, 12)}, ledger chg-2`, report = reportOf(p, auto1.run.id);
  assert.deepEqual(asked(auto1.run.id), [`   ${done}`, ...[2, 3, 4, 5].map((n, i) => `${i + 1}. Apply fix ${n}, for shared-cache-lock? Answer Apply or Skip.`)]);
  const post = lfm({}, 'signoff', 'post', '--run', String(auto1.run.id)); assert.equal(post.status, 0, post.stderr);
  assert.deepEqual([post.stdout.split('\n')[0], [...post.stdout.matchAll(/^kept: lfm-\d+-(\d+)-/gm)].map((m) => m[1])], [done, ['2', '3', '4', '5']]);
  // A run saved before apply moved ahead of report (report ord 9, apply ord 10) resumes in today's order: apply, then report again.
  const old = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  try { old.exec(`UPDATE steps SET ord = 19 - ord, status = CASE name WHEN 'apply' THEN 'failed' ELSE status END WHERE run_id = ${auto1.run.id} AND name IN ('report', 'apply'); UPDATE runs SET status = 'failed' WHERE id = ${auto1.run.id}`); } finally { old.close(); }
  rmSync(join(p, '.lfm', 'runs', String(auto1.run.id), 'report.txt')); const before2 = calls().length;
  const resumed = lfm(fake, 'rerun', '--resume', '--run', String(auto1.run.id), '--wait', '1m', '--json'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).steps.slice(-2).map((s) => [s.name, s.status]), [['apply', 'completed'], ['report', 'completed']]);
  assert.deepEqual([reportOf(p, auto1.run.id), calls().length], [report, before2], 'the branch is kept, so the worker is not called again');
});

test('propose: a rule-breaking fix is sent back once, then dropped on the second answer while the valid fixes are kept', () => {
  const { p, lfm, query, calls, lines } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'long' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run } = JSON.parse(r.stdout);
  const asks = calls().filter((c) => c.stdin.startsWith(`lfm-run:${run.id}:propose\n`));
  assert.equal(asks.length, 2, 'the worker is asked once more, with the problem');
  assert.match(asks[1].stdin, /Your last answer was not valid: proposals\[1\]\.change has more than 3 sentences\./);
  assert.deepEqual(query('SELECT target FROM proposals WHERE run_id = ?', run.id), [{ target: 'launch script 1' }]);
  assert.ok(lines('propose', run.id).includes('dropped: proposals[1].change has more than 3 sentences'));
  assert.equal(lines('propose', run.id).at(-1), 'fixes: 1 proposed, reasons: 0 of 0 follow-ups');
  const badKind = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_KIND: 'guess' }, 'retro', '--foreground', '--json');
  assert.equal(badKind.status, 0, badKind.stderr);
  const badId = JSON.parse(badKind.stdout).run.id;
  assert.match(calls().at(-1).stdin, /Your last answer was not valid: proposals\[0\]\.kind must be doc, rule or code/);
  assert.equal(query('SELECT count(*) AS n FROM proposals WHERE run_id = ?', badId)[0].n, 0);

  // A non-plain word names its replacement and passive voice is refused the same way: sent back once naming the
  // field, the sentence and the offending word, then dropped while the plain fix is kept and reported.
  const plainRun = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'plain' }, 'retro', '--foreground', '--json');
  assert.equal(plainRun.status, 0, plainRun.stderr);
  const plainId = JSON.parse(plainRun.stdout).run.id;
  const retries = calls().filter((c) => c.stdin.startsWith(`lfm-run:${plainId}:propose\n`));
  assert.equal(retries.length, 2, 'the worker is asked once more, with the problem');
  assert.match(retries[1].stdin, /Your last answer was not valid: proposals\[1\]\.change: sentence 1 uses "utilize"; use "use" instead; proposals\[2\]\.change: sentence 1 is passive \("was held"\); rewrite it in the active voice\./);
  assert.deepEqual(query('SELECT target FROM proposals WHERE run_id = ?', plainId), [{ target: 'launch script 1' }]);
  assert.ok(lines('propose', plainId).includes('dropped: proposals[1].change: sentence 1 uses "utilize"; use "use" instead; proposals[2].change: sentence 1 is passive ("was held"); rewrite it in the active voice'));
  assert.deepEqual(lines('check', plainId), ['fixes: 1 kept of 1, problems: 0']);
  assert.match(reportOf(p, plainId), /^Fix 1, for shared-cache-lock:\n[\s\S]*?^- Change:\n {2}Give each worker its own cache directory\.\n/m);
});
