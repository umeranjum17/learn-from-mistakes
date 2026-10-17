// End-to-end: runs the real CLI on copies of the synthetic examples (state in the copy's .lfm/) with a throwaway LFM_HOME.
// The report is the privacy-bounded lfm-report.v2 (identifiers, counts and verdict words, never prose); lfm-changes.v1
// carries only the owner-written what/why of each applied change.
// LFM_CLI points the same journeys at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';
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
  const fakes = join(tmp, 'fakes');
  mkdirSync(fakes);
  for (const name of ['claude', 'codex']) symlinkSync(FAKE_AGENT, join(fakes, name));
  const env = { ...process.env, PATH: `${fakes}${delimiter}${process.env.PATH}`, LFM_HOME: join(tmp, 'home') };
  mkdirSync(env.LFM_HOME);
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), AGENTS_SET);
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', join(tmp, 'p')], { encoding: 'utf8', env });
  const raw = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env });
  return { p: join(tmp, 'p'), lfm, raw, env };
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

test('the state-dir fix lines name the resolved global config, never a literal $LFM_HOME', () => {
  const { p, lfm, env } = setup();
  const global = join(env.LFM_HOME, 'config.yaml');
  writeFileSync(join(p, '.lfm'), 'a stray file where the state dir should be');
  const inner = lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(inner.status, 2, inner.stderr);
  assert.match(inner.stderr, /cannot create the state dir \(EEXIST\)/);
  assert.equal(inner.stderr.match(/^next: (.*)$/m)[1], `mv <project>/.lfm <elsewhere>   # free .lfm for the state dir, or set state_root in ${global}`);
  rmSync(join(p, '.lfm'));
  const blocker = join(env.LFM_HOME, 'blocker'); // a file stands where the configured state_root's parent dir would go
  writeFileSync(blocker, '');
  appendFileSync(global, `state_root: ${join(blocker, 'root')}\n`);
  const outer = lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(outer.status, 2, outer.stderr);
  assert.match(outer.stderr, /cannot create the state dir \(ENOTDIR\)/);
  assert.equal(outer.stderr.match(/^next: (.*)$/m)[1], `edit state_root in ${global}   # a dir lfm can create and write`);
  assert.doesNotMatch(outer.stderr, /\$LFM_HOME/);
});

test('same-named projects keep separate state; a global state_root still wins', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-'));
  after(() => rmSync(tmp, { recursive: true }));
  const env = { ...process.env, LFM_HOME: join(tmp, 'home') };
  mkdirSync(env.LFM_HOME);
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), AGENTS_SET);
  const projects = ['a', 'b'].map((parent) => {
    const dir = join(tmp, parent, 'shop'); // same basename, different parents, no `name:` in either config
    cpSync(new URL('../examples', import.meta.url).pathname, dir, { recursive: true });
    writeFileSync(join(dir, 'defects.md'), `## 2026-03-0${parent === 'a' ? 1 : 2}\n- only in ${parent}\n`);
    writeFileSync(join(dir, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\ncauses: { flaky: { description: d } }\n');
    return dir;
  });
  const run = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', dir], { encoding: 'utf8', env });
  assert.equal(run(projects[0], 'change', 'applied', '--cause', 'flaky', '--ref', 'abc1234').status, 0);
  assert.equal(JSON.parse(run(projects[1], 'changes', '--json').stdout).changes.length, 0);

  mkdirSync(join(tmp, 'home'), { recursive: true });
  writeFileSync(join(tmp, 'home', 'config.yaml'), `${AGENTS_SET}state_root: ${join(tmp, 'root')}\n`);
  rmSync(join(projects[0], '.lfm'), { recursive: true });
  const r = run(projects[0], 'change', 'applied', '--cause', 'flaky', '--ref', 'abc1234');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(tmp, 'root', 'shop', 'changes.jsonl'))); // <state_root>/<name>
  assert.ok(!existsSync(join(tmp, 'root', 'shop', '.gitignore')), 'the .gitignore is only for the in-project default');
  assert.ok(!existsSync(join(projects[0], '.lfm')), 'an override writes nothing into the project');
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
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(raw('frobnicate').status, 2); // an unknown command is still a usage error
});

test('runs that never read a store print no ExperimentalWarning', () => {
  const { p, lfm, raw } = setup();
  for (const r of [raw('--version'), raw('--help'), raw('guide')]) {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  }
  // A project command that never opens a store stays quiet too.
  for (const r of [lfm('changes')]) {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  }
});

test('every rejected input names what was wrong and a next step, never the whole usage', () => {
  const { p, lfm, raw } = setup();
  const RETRO = /^next: learn-from-mistakes-axi retro --wait 8m$/m;
  const HELP = /^next: learn-from-mistakes-axi --help   # supported commands and options$/m;
  const CHANGE = /^next: learn-from-mistakes-axi change applied \(--cause <cause> \| --proposal <run>:<n>\) --ref <ref> \[--metric <metric>\] \[--tripwire "<op> <number>"\] \[--kind doc\|rule\|code\] \[--at <time>\]/m;
  const known = '(known: server-memory-kill, shared-cache-lock, agent-exit-wait; "other" is reserved)';
  const applied = (...args) => lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', ...args);
  const cfgFile = join(p, '.learn-from-mistakes.yaml'), v1 = readFileSync(cfgFile, 'utf8');
  const withConfig = (extra, base = v1) => { writeFileSync(cfgFile, base + extra); try { return lfm('changes'); } finally { writeFileSync(cfgFile, v1); } };
  const bad = (rule) => new RegExp(`^error: .*\\.learn-from-mistakes\\.yaml: ${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
  for (const [run, code, error, next] of [
      [() => raw('frobnicate'), 2, 'unknown command "frobnicate" (commands: init, doctor, guide, report, change applied, changes, retro, status, runs, attach, logs, abort, rerun, agents, signoff, apply)', HELP],
    [() => raw('--bogus'), 2, 'unknown option "--bogus"', HELP], // a bare unknown flag points at --help
    [() => raw('report', '--bogus'), 2, 'unknown option "--bogus"', /^next: learn-from-mistakes-axi report \[--dir <dir>\]/m],
    [() => raw('change'), 2, '"change" must be followed by "applied"', CHANGE],
    [() => raw('report', 'extra'), 2, 'unexpected argument "extra"', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('report', '--dir'), 2, '--dir needs a value', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('changes', '--full'), 2, 'changes does not take --full', /^next: learn-from-mistakes-axi changes \[--dir <dir>\] \[--json\]$/m], // before any config is read
    [() => raw('ingest', '--json'), 2, 'ingest was removed: a retro reads the sources, labels and counts them', RETRO], // the manual flow is gone
    [() => raw('count'), 2, 'count was removed: a retro reads the sources, labels and counts them', RETRO],
    [() => raw('report', '--labels', 'x'), 2, '--labels was removed: a retro labels the records and checks the fixes', RETRO],
    [() => raw('report', '--cause', 'x'), 2, 'report does not take --cause', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('--cause', 'x'), 2, 'learn-from-mistakes-axi does not take --cause', HELP], // bare: no command was typed, so --help
    [() => raw('report', '--dir', 'a\u001b[31m'), 2, '--dir (invalid value): a path must not contain control characters', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('init', '--sessions', 'y'.repeat(81)), 2, /^error: --sessions \(invalid value\) must list agents by name: /, /^next: learn-from-mistakes-axi init --sessions claude,pi/m], // never echoes a long value
    [() => raw('init', '--sessions', 'a\u001b[31m'), 2, /^error: --sessions \(invalid value\) must list agents by name: /, /^next: learn-from-mistakes-axi init --sessions claude,pi/m], // nor a control character
    [() => raw(), 2, /^error: no \.learn-from-mistakes\.yaml in .*\n(.*\n)*  log: \{ type: markdown-log, path: defects\.md \}/m, /^next: learn-from-mistakes-axi init   # writes the config for this project$/m], // a config to copy, or init
    [() => lfm('change', 'applied', '--cause', 'nope', '--ref', 'abc1234'), 2, `unknown cause "nope" ${known}`, CHANGE],
    [() => lfm('change', 'applied', '--cause', 'other', '--ref', 'abc1234'), 2, /^error: cause "other" is reserved and never recordable \(known: server-memory-kill,/m, CHANGE],
    [() => lfm('change', 'applied', '--cause', 'y'.repeat(81), '--ref', 'abc1234'), 2, `unknown cause (invalid value) ${known}`, CHANGE], // never echoes a long value
    [() => lfm('change', 'applied', '--cause', 'a\u001b[31m', '--ref', 'abc1234'), 2, `unknown cause (invalid value) ${known}`, CHANGE], // nor a control character
    [() => lfm('change', 'applied', '--cause', 'server-memory-kill'), 2, 'change applied needs --ref', CHANGE],
    [() => lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'XYZ'), 2, '--ref "XYZ" must be a 7-40 lowercase hex commit or sha256:<64 lowercase hex>', /^next: git rev-parse HEAD/m],
    [() => applied('--at', 'not-a-time'), 2, '--at "not-a-time" must be an ISO 8601 time', /^next: learn-from-mistakes-axi change applied --cause server-memory-kill --ref abc1234 --at 2026-10-12T09:00:00Z/m],
    [() => applied('--full'), 2, 'change applied does not take --full', CHANGE],
    [() => applied('--tripwire', '< x'), 2, '--tripwire "< x" must be "<op> <number>" with op >=, <=, >, < or =, such as "<= 0"', CHANGE],
    [() => applied('--tripwire', '=< 1'), 2, '--tripwire "=< 1" must be "<op> <number>" with op >=, <=, >, < or =, such as "<= 0"', CHANGE],
    [() => applied('--metric', 'speed'), 2, /^error: --metric "speed" must be a metric \(merged, first_pass, .*, or cause_count:<cause>, or gate_failures:<step>\)$/m, CHANGE],
    [() => applied('--metric', 'cause_count:nope'), 2, /^error: --metric "cause_count:nope" must be a metric \(/m, CHANGE], // a cause the config does not name
    [() => applied('--kind', 'policy'), 2, '--kind "policy" must be doc, rule or code', CHANGE],
    [() => applied('--why', '   '), 2, '--why "   " must be one line of 1-200 characters, with no line breaks or control characters', CHANGE],
    [() => applied('--what', 'x'.repeat(201)), 2, '--what (invalid value) must be one line of 1-200 characters, with no line breaks or control characters', CHANGE],
    [() => applied('--what', ''), 2, '--what "" must be one line of 1-200 characters, with no line breaks or control characters', CHANGE],
    [() => raw('retro', '--wait', '8'), 2, '--wait "8" must be a time like 30s, 8m or 1h', /^next: learn-from-mistakes-axi retro \[--wait \[<time>\] \| --foreground\]/m],
    [() => raw('retro', '--wait', '1m', '--foreground'), 2, 'pass --wait or --foreground, not both', /^next: learn-from-mistakes-axi retro \[/m],
    [() => raw('rerun', '--resume', '--foreground'), 2, 'rerun does not take --foreground', /^next: learn-from-mistakes-axi rerun \[--resume\] /m],
    [() => raw('logs'), 2, 'logs needs --step', /^next: learn-from-mistakes-axi logs --step <name> \[--run <id>\]/m],
    [() => raw('logs', '--step', 'Collect;'), 2, '--step "Collect;" must be a step name such as collect or report', /^next: learn-from-mistakes-axi logs --step <name>/m],
    [() => raw('attach', '--wait', '1m'), 2, 'attach does not take --wait', /^next: learn-from-mistakes-axi attach \[--run <id>\]/m],
    [() => raw('status', '--run', '0'), 2, '--run "0" must be a run id that runs lists', /^next: learn-from-mistakes-axi status \[--run <id>\]/m],
    [() => raw('runs', '--full'), 2, 'runs does not take --full', /^next: learn-from-mistakes-axi runs /m],
    [() => raw('agents', '--test', 'gpt'), 2, '--test "gpt" must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>', /^next: learn-from-mistakes-axi agents \[--test <runner>\]/m],
    [() => raw('agents', '--test', 'acp:../..'), 2, '--test "acp:../.." must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>', /^next: learn-from-mistakes-axi agents \[--test <runner>\]/m], // a target never leaves runs/
    [() => raw('agents', '--test', 'ACP:Foo'), 2, '--test "ACP:Foo" must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>', /^next: learn-from-mistakes-axi agents \[--test <runner>\]/m],
    [() => raw('agents', '--test', 'acp'), 2, '--test "acp" must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>', /^next: learn-from-mistakes-axi agents \[--test <runner>\]/m],
    [() => raw('agents', '--test', 'acp:foo:bar'), 2, '--test "acp:foo:bar" must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>', /^next: learn-from-mistakes-axi agents \[--test <runner>\]/m], // an acp target carries no colon; only a byokit route does
    [() => withConfig('agent: "acp:foo:bar"\n'), 2, bad('agent must be claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>'), HELP], // nor a config agent name
    [() => raw('agents', '--test', 'claude'), 2, /^error: no \.learn-from-mistakes\.yaml in /m, /^next: learn-from-mistakes-axi init/m], // --test writes in the project's state dir
    [() => withConfig('agent: [codex, claude]\n'), 2, bad('agent must be one agent, not a list'), /^next: ask the user which one agent to use, then set agent in \S+\.learn-from-mistakes\.yaml to it; the run never picks one$/m],
    [() => withConfig('agent: 3\n'), 2, bad('agent must be claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>'), HELP],
    [() => withConfig('worker: { runner: claude }\n'), 2, bad('unknown key worker'), HELP], // the old role keys are gone, with no alias
    [() => withConfig('agent_config: { claude: { model: 5 } }\n'), 2, bad('agent_config.claude.model must be a model id (letters, digits and . _ / : @ + -, not starting with -), and <provider>/<model> for opencode'), HELP],
    [() => withConfig('agent_config: { gemini: { effort: low } }\n'), 2, bad('agent_config.gemini.effort: gemini has no effort setting; remove it'), HELP],
    [() => withConfig('agent_config: { opencode: { model: muse } }\n'), 2, bad('agent_config.opencode.model must be a model id (letters, digits and . _ / : @ + -, not starting with -), and <provider>/<model> for opencode'), HELP],
    [() => withConfig('agent_config: { claude: { model: "--yolo" } }\n'), 2, bad('agent_config.claude.model must be a model id (letters, digits and . _ / : @ + -, not starting with -), and <provider>/<model> for opencode'), HELP], // a model is never an argv flag
    [() => withConfig('agent_path_override: { claude: ./claude }\n'), 2, /^error: .*\.learn-from-mistakes\.yaml: agent_path_override is global-only: set it in .*config\.yaml$/m, HELP], // a cloned repo never picks the binary
    [() => withConfig('window: 7 days\n'), 2, bad('window must be a number of days, such as 7d'), HELP],
    [() => withConfig('targets: { first_pass: 70 }\n'), 2, bad('targets.first_pass must be a quoted "<op> <number>", such as ">= 70"'), HELP],
    [() => withConfig('targets: { speed: ">= 1" }\n'), 2, /^error: .*: targets: speed must be a metric \(merged, first_pass, .*, or cause_count:<cause>, or gate_failures:<step>\)$/m, HELP],
    [() => withConfig('agent_timeout: 20\n'), 2, bad('agent_timeout must be a duration such as 90s, 20m or 1h'), HELP],
    [() => withConfig('caps: { tokens: 5 }\n'), 2, bad('caps: unknown key tokens'), HELP],
    [() => withConfig('followup: { min_days: 0 }\n'), 2, bad('followup.min_days must be a positive integer'), HELP],
    [() => withConfig('excerpts: maybe\n'), 2, bad('excerpts must be on or off'), HELP],
    [() => withConfig('signoff: auto\n'), 2, bad('signoff: auto is not a value; use on (the default) or off'), HELP],
    [() => withConfig('', v1.replace('sources:\n', 'sources:\n  s: { type: sessions }\n  more: { type: sessions }\n')), 2,
      bad('sources.s: sources.more already reads sessions; keep one and list every agent in its agents'), HELP],
    [() => withConfig('', v1.replace('sources:\n', 'sources:\n  prs: { type: github }\n  more: { type: github }\n')), 2,
      bad("sources.prs: sources.more already reads the PRs of origin's GitHub repo; keep one"), HELP],
    ...[['source: log', 'causes.env.match.source must name a no-mistakes or sessions source'], ['source: gate, signal: test_fail', 'causes.env.match: unknown key signal'],
      ['source: s', 'causes.env.match needs a signal, tool or text_contains'], ['source: s, tool: ""', 'causes.env.match.tool must be a non-empty string'],
      ['source: s, signal: oops', 'causes.env.match.signal must be one of tool_error, nonzero_exit, test_fail, correction, interrupt, retry'],
    ].map(([m, rule]) => [() => withConfig('', v1.replace('sources:\n', 'sources:\n  s: { type: sessions, agents: [claude] }\n').replace('causes:\n', `causes:\n  env: { description: x, match: { ${m} } }\n`)), 2, bad(rule), HELP]),
    [() => withConfig('', v1.replace(/^name: .*$/m, 'name: 123')), 2, bad('name must be a string'), HELP],
    [() => withConfig('', v1.replace('causes:\n', 'causes:\n  Shared_Cache: { description: x }\n')), 2, bad('causes.Shared_Cache: a cause key must be 1-64 of a-z, 0-9 and - (rename it, for example to shared-cache)'), HELP],
  ]) {
    const r = run();
    const what = typeof error === 'string' ? error : String(error);
    assert.equal(r.status, code, `${what}\n${r.stderr}`);
    assert.equal(r.stdout, '', what);
    if (typeof error === 'string') assert.ok(r.stderr.split('\n').includes(`error: ${error}`), `${what}\n${r.stderr}`);
    else assert.match(r.stderr, error);
    assert.match(r.stderr, next, what);
    assert.doesNotMatch(r.stderr, /usage: learn-from-mistakes-axi|--dir <dir> +project dir/, `${what}: printed the usage block`);
    assert.doesNotMatch(r.stderr, /y{81}|\u001b/, `${what}: echoed a long or control value`);
  }
  assert.equal(withConfig('targets: { "gate_failures:lint": "= 0" }\n').status, 0); // a per-step gate failure is a target metric
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

test('a retro identifies the store by the rows it read, not its mtime, and never writes the store', () => {
  const { p, lfm } = setup();
  const db = join(p, 'gate.sqlite');
  const bytes = () => createHash('sha256').update(readFileSync(db)).digest('hex');
  const readHash = () => {
    const before = bytes();
    const r = lfm('retro', '--foreground');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bytes(), before); // the read leaves the store's bytes as they were
    const hash = JSON.parse(readFileSync(join(p, '.lfm', 'sources.json'), 'utf8')).sources.find((s) => s.id === 'gate').hash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    return hash;
  };
  const first = readHash();
  utimesSync(db, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z')); // same rows, new mtime
  assert.equal(readHash(), first);

  const w = new DatabaseSync(db);
  w.prepare("UPDATE step_results SET error = 'not read' WHERE id = 'step-2'").run(); // a completed step: new bytes, same rows read
  assert.equal(readHash(), first);
  const { atime, mtime } = statSync(db);
  w.prepare("UPDATE step_results SET error = 'lint: 3 errors' WHERE id = 'step-5'").run(); // one failed step's text
  w.close();
  utimesSync(db, atime, mtime); // changed rows, same mtime
  assert.equal(Math.round(statSync(db).mtimeMs), mtime.getTime());
  assert.notEqual(readHash(), first);
});

test('a store row with no timestamp still counts as a row but never as a day', () => {
  const { p, lfm } = setup();
  const w = new DatabaseSync(join(p, 'gate.sqlite'));
  w.exec(`UPDATE step_results SET started_at = 1772618400, completed_at = 1772619000 WHERE id IN ('step-1', 'step-3');
    UPDATE step_results SET started_at = NULL, completed_at = NULL WHERE id = 'step-4';`); // 3 matching rows on one day, 1 undated
  w.close();
  assert.equal(lfm('retro', '--foreground').status, 0);
  const r = lfm('report', '--json');
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout).causes.find((x) => x.cause === 'agent-exit-wait');
  assert.deepEqual(c.store, { matched: true, rows: 4, days: 1 });
  assert.equal(c.repeated, false); // min_days: 2 is not met by one real day
});

test('private canary prose never reaches default, --json, --full or stderr; the agents\' canary text reaches only report.txt', () => {
  // A source record and each text field the worker and the judge write (finding summary, label why, fix change, verdict reason) carry the canary.
  const run = agentSetup(), yaml = join(run.p, '.learn-from-mistakes.yaml'), agents = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_CANARY: CANARY };
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }'));
  appendFileSync(join(run.p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  const outs = [run.lfm(agents, 'retro', '--foreground'), run.lfm(agents, 'retro', '--foreground', '--json')];
  const id = JSON.parse(outs[1].stdout).run.id;
  outs.push(run.lfm({}), run.lfm({}, '--json'), run.lfm({}, 'status'), run.lfm({}, 'attach', '--json'), run.lfm({}, 'report'), run.lfm({}, 'report', '--full'), run.lfm({}, 'report', '--full', '--json'), ...['analyse', 'propose', 'verify', 'check', 'report'].map((step) => run.lfm({}, 'logs', '--step', step)));
  for (const r of outs) {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(CANARY));
  }
  assert.equal(run.query(`SELECT count(*) AS n FROM labels WHERE run_id = ? AND why LIKE '%${CANARY}%'`, id)[0].n, 3);
  assert.ok(reportOf(run.p, id).includes(`  Give each worker its own cache directory ${CANARY}.\n`), 'report.txt shows the change');
  // A change that names a path is refused at propose on the report's no-ids rule and sent back once; the fake agent
  // answers the same, so the second answer's proposals are dropped and none is stored: nothing is hidden either.
  const pathyRet = run.lfm({ ...agents, FAKE_CANARY: `${CANARY} in src/cache.mjs` }, 'retro', '--foreground', '--json');
  assert.equal(pathyRet.status, 0, pathyRet.stderr);
  assert.doesNotMatch(pathyRet.stdout + pathyRet.stderr, new RegExp(CANARY));
  const pathy = JSON.parse(pathyRet.stdout).run.id;
  const pathyLog = readFileSync(join(run.p, '.lfm', 'runs', String(pathy), 'propose.log'), 'utf8');
  assert.match(pathyLog, /^worker answer 1 is not valid: proposals\[0\]\.change: sentence 1 names a path, file name or id; put the file in target and ids in refs/m);
  assert.match(pathyLog, /^dropped: proposals\[0\]\.change: sentence 1 names a path, file name or id/m);
  const pathyReport = reportOf(run.p, pathy);
  assert.ok(!pathyReport.includes('cache.mjs') && pathyReport.includes('- No fix passed the rules.'), pathyReport);
  // A change that still breaks a rule at report time shows trimmed, with the proposal that holds the rest.
  const w = new DatabaseSync(join(run.p, '.lfm', 'lfm.sqlite'));
  w.prepare('UPDATE proposals SET change = ? WHERE run_id = ? AND n = 1').run(`Give each worker its own cache directory. Edit src/cache.mjs to add the lock ${CANARY}.`, id);
  w.prepare('UPDATE proposals SET change = ? WHERE run_id = ? AND n = 2').run('Edit src/cache.mjs to add the lock.', id);
  w.prepare("UPDATE steps SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL, output_json = NULL WHERE run_id = ? AND name = 'report'").run(id);
  w.prepare("UPDATE runs SET status = 'interrupted', error = NULL WHERE id = ?").run(id);
  w.close();
  const again = run.lfm({}, 'rerun', '--resume', '--run', String(id), '--wait', '1m', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout + again.stderr, new RegExp(CANARY));
  const trimmed = reportOf(run.p, id);
  assert.ok(trimmed.includes('  Give each worker its own cache directory.\n   Proposal ' + id + ':1: the rest of this text breaks the report rules.\n'), trimmed);
  assert.ok(trimmed.includes('  This text breaks the report rules, so the report hides it.\n   Proposal ' + id + ':2 holds the text.\n'), trimmed);
  assert.ok(!trimmed.includes('cache.mjs'), trimmed);
  // excerpts: off: no defect record id is the plain sha256 of its text, which anyone who guesses a bullet could compute. A bullet
  // keeps its id from run to run, each label names the record its bundle line points at, report.txt's Evidence opens those
  // lines, and the store's salt reaches no output.
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}excerpts: off\n`);
  const off = run.lfm(agents, 'retro', '--foreground', '--json'), offId = JSON.parse(off.stdout).run.id;
  const bundle = readFileSync(join(run.p, '.lfm', 'runs', String(offId), 'bundle.md'), 'utf8');
  const at = new Map([...bundle.matchAll(/^- \[([^\]]+)\] log at (\S+), /gm)].map((m) => [m[1], m[2]]));
  const logged = (r) => run.query(`SELECT record_id, ref, text FROM records WHERE run_id = ? AND source = 'log' ORDER BY record_id`, r);
  assert.deepEqual(logged(offId).map((r) => r.record_id), logged(id).map((r) => r.record_id));
  for (const r of logged(offId)) assert.notEqual(r.record_id.split('~')[0], createHash('sha256').update(r.text.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 12));
  const labels = run.query('SELECT record_id FROM labels WHERE run_id = ? ORDER BY record_id', offId).map((l) => l.record_id);
  assert.deepEqual(labels, [...at.keys()].toSorted());
  for (const r of logged(offId).filter((x) => at.has(x.record_id))) assert.equal(r.ref, at.get(r.record_id));
  const text = reportOf(run.p, offId);
  assert.deepEqual(text.match(/^- shared-cache-lock: .+\n {3}Evidence: (.+)$/m)[1].split('; ').toSorted(), labels.map((l) => at.get(l).replace(/^.*\//, '')).toSorted());
  const salt = Buffer.from(run.query('SELECT salt FROM secret')[0].salt);
  for (const s of [bundle, text, ...[off, ...outs].map((o) => o.stdout + o.stderr)]) assert.ok(!s.includes(salt.toString('hex')) && !s.includes(salt.toString('base64')), 'the store salt in an output');
});

test('a fix shows the finding its refs cite, not the first finding with the same cause', () => {
  const run = agentSetup(), yaml = join(run.p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }'));
  const r = run.lfm({ FAKE_ANALYSE: 'label', FAKE_FINDINGS: 'twins', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'twin' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const text = reportOf(run.p, JSON.parse(r.stdout).run.id);
  assert.match(text, /^Fix 1, for shared-cache-lock:\n- Finding:\n  Second twin failed alone\.\n/m);
  assert.doesNotMatch(text, /First twin/);
});

test('duplicate labels collapse to one incident, occurrences add, and log and store totals never add', () => {
  const run = agentSetup();
  const dup = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'agent-exit-wait', FAKE_DUP: '1' };
  const r = run.lfm(dup, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const collapsed = JSON.parse(run.lfm({}, 'report', '--json').stdout).causes.find((c) => c.cause === 'agent-exit-wait');
  assert.deepEqual(collapsed.log, { incidents: 1, records: 2, days: 1 }); // two labels, the second a duplicate: one incident
  const o = run.lfm({ ...dup, FAKE_OCC: '3' }, 'retro', '--foreground', '--json');
  assert.equal(o.status, 0, o.stderr);
  const id = JSON.parse(o.stdout).run.id;
  const added = JSON.parse(run.lfm({}, 'report', '--json').stdout).causes.find((c) => c.cause === 'agent-exit-wait');
  assert.deepEqual(added.log, { incidents: 3, records: 2, days: 1 }); // the kept record counts three times
  assert.deepEqual([added.store.rows, added.store.days], [4, 3]);
  const propose = run.calls().find((c) => c.stdin.startsWith(`lfm-run:${id}:propose`)).stdin;
  assert.match(propose, /^- agent-exit-wait: 4 incidents on 3 days, repeated$/m); // max(3, 4), never 3 + 4
});

test('signoff: off keeps the section-7 questions in report.txt even when sign-off is installed', () => {
  const run = agentSetup(), yaml = join(run.p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }')}signoff: off\n`);
  symlinkSync(new URL('./fake-agent/sign-off-axi', import.meta.url).pathname, join(run.bin, 'sign-off-axi'));
  const r = run.lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const id = JSON.parse(r.stdout).run.id;
  const text = reportOf(run.p, id);
  assert.doesNotMatch(text, /signoff post/);
  const kept = run.query('SELECT n FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n', id).map((f) => f.n);
  assert.ok(kept.length > 0);
  assert.deepEqual(text.split('\n').filter((l) => /^\d+\. Apply/.test(l)), kept.map((n) => `${n}. Apply fix ${n}, for shared-cache-lock? Answer Apply or Skip.`));
});

test('a bad source is a config error or a failed collect step, never a crash', () => {
  const { p, lfm } = setup();
  const cfg = join(p, '.learn-from-mistakes.yaml');
  const load = (yaml) => { writeFileSync(cfg, yaml); const r = lfm('changes'); assert.equal(r.status, 2, r.stderr); return r.stderr; };
  assert.match(load('sources:\n  log: { type: markdown-log }\n  prs: { type: github }\n'), /^error: .*: sources\.log\.path must be a string$/m); // each source type checks its own keys
  assert.match(load('sources:\n  log: { type: [markdown-log], path: defects.md }\n'), /^error: .*: sources\.log\.type must be one of markdown-log, no-mistakes, sessions, github, done-done, firstmate$/m); // a list is not a type
  assert.match(load('sources:\n  prs: { type: github, repo: umer/app }\n'), /^error: .*: sources\.prs: unknown key repo$/m); // the repo comes from origin
  const collect = (yaml) => { writeFileSync(cfg, yaml); const r = lfm('retro', '--foreground', '--json'); assert.doesNotMatch(r.stderr, /\n\s+at /); return JSON.parse(r.stdout).run.error; }; // no stack trace
  cpSync(join(p, 'gate.sqlite'), join(p, 'old.sqlite')); // a store of a no-mistakes version without a column the read uses
  const old = new DatabaseSync(join(p, 'old.sqlite'));
  old.exec('ALTER TABLE step_results DROP COLUMN step_name');
  old.close();
  assert.equal(collect('sources:\n  gate: { type: no-mistakes, path: old.sqlite }\n'), 'collect: source gate: unknown store schema (no step_results.step_name) (0 records read)');
});
  test('an oversized source streams into the store instead of overflowing the call stack', () => {
    const { p, lfm } = setup();
    // Far more records than the stack can spread in one push (500000 already throws
    // RangeError: Maximum call stack size exceeded): a retro collects them without overflowing.
    const lines = ['# defects', '', '## 2026-01-05'];
    for (let i = 0; i < 600000; i++) lines.push(`- [area] defect ${i} happened -> impact -> action`);
    writeFileSync(join(p, 'defects.md'), lines.join('\n') + '\n');
    writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
    const r = lfm('retro', '--foreground', '--json');
    assert.equal(r.status, 0, r.stderr);
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
  const keyed = (text) => createHmac('sha256', salt).update(text).digest('hex').slice(0, 12);
  const dd = (id, step) => `dd:${keyed(`notes/${id}/${step}`)}`;
  const file = (id) => join(env.DONE_DONE_HOME, 'runs', 'notes', id, 'run.json');
  const ref = (id) => join('<done-done home>', 'runs', keyed('notes'), id, 'run.json');
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
  assert.deepEqual(Object.keys(firstEntry).sort(), ['at', 'cause', 'id', 'kind', 'metric', 'ref', 'v']); // no --tripwire: none saved
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
    metric: 'tool_error_rate', tripwire: '<= 0.05', kind: 'rule' }); // the echo never carries what/why; the tripwire in one form
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
    { id: 'chg-1', cause: 'server-memory-kill', ref: 'abc1234', at: firstEntry.at, metric: 'cause_count:server-memory-kill', tripwire: '', kind: 'doc', what: '', why: '' },
    { id: 'chg-2', cause: 'server-memory-kill', ref: REF2, at: '2026-01-02T03:04:05.000Z', metric: 'tool_error_rate', tripwire: '<= 0.05', kind: 'rule', what: WHAT, why: WHY },
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
    metric: 'cause_count:shared-cache-lock', tripwire: '', kind: 'doc', what: 'x'.repeat(200), why: 'y' });

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

test('change applied refuses a metric the ledger would not read back, and writes nothing', () => {
  const { p, lfm } = setup();
  const ledger = join(p, '.lfm', 'changes.jsonl');
  assert.equal(lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234').status, 0);
  const before = readFileSync(ledger);
  for (const metric of ['cause_count:server-memory-kill\u2028break', `cause_count:${'x'.repeat(190)}`]) {
    const explicit = lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', '--metric', metric);
    assert.equal(explicit.status, 2, metric);
    assert.match(explicit.stderr, /must be a metric/);
    assert.ok(readFileSync(ledger).equals(before), `refused input changed the ledger: ${metric}`);
  }
  const exported = lfm('changes', '--json');
  assert.equal(exported.status, 0, exported.stderr); // the ledger still reads
  assert.equal(JSON.parse(exported.stdout).changes.length, 1);
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

test('a review log under another id with review: true does not count as defects', () => {
  const { p, env } = setup();
  execFileSync('git', ['-C', p, 'init', '-q']);
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(p, 'defects.md'), `## ${day}\n- one\n- two\n- three\n`);
  writeFileSync(join(p, 'notes.md'), `- ${day} umer: first review\n- ${day} umer: second review\n`);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n  code-review: { type: markdown-log, path: notes.md, review: true }\ncauses: { flaky: { description: d } }\n');
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

test('a source id of reviews without the flag is still not counted as defects', () => {
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
  assert.deepEqual(run.steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['propose', 'completed'], ['verify', 'completed'], ['check', 'completed'], ['apply', 'completed'], ['report', 'completed']]);
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
  assert.deepEqual(JSON.parse(steps[9].output_json).coverage, { labelled: 0, total_records: 18, unlabelled: 18 }); // no labels yet
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
caps: { invocations: 12, bundle_chars: 60000 }
signoff: on
`);
  mkdirSync(join(p, '..', 'home'), { recursive: true });
  writeFileSync(join(p, '..', 'home', 'config.yaml'), 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna, effort: low } }\nagent_timeout: 5m\nagent_path_override: { claude: ' + FAKE_AGENT + ' }\nagent_args_override: { codex: [--profile, cheap] }\nacpx_path: acpx\n');
  const v2 = lfm('retro', '--foreground', '--json');
  assert.equal(v2.status, 0, v2.stderr);
  assert.deepEqual(JSON.parse(v2.stdout).steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['propose', 'completed'], ['verify', 'completed'], ['check', 'completed'], ['apply', 'completed'], ['report', 'completed']]);
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
  assert.deepEqual(f.steps.map((s) => s.status), ['completed', 'completed', ...Array(7).fill('pending'), 'failed']);
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

test('signoff post, signoff answers and change applied --proposal map an unusable run store to one usage line, never a stack', () => {
  const { p, lfm } = setup();
  mkdirSync(join(p, '.lfm'));
  writeFileSync(join(p, '.lfm', 'lfm.sqlite'), 'not a database '.repeat(64));
  for (const args of [['signoff', 'post'], ['signoff', 'answers'], ['change', 'applied', '--proposal', '1:1', '--ref', 'abc1234']]) {
    const r = lfm(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /^error: .*lfm\.sqlite: not a usable run store/m);
    assert.match(r.stderr, /^next: mv .*lfm\.sqlite <elsewhere>/m);
    assert.doesNotMatch(r.stderr, /\n\s+at /); // no stack trace
  }
});

test('retro runs in a detached worker; a killed worker is interrupted and rerun --resume finishes it', async () => {
  const { p, lfm, env } = setup();
  const waited = lfm('retro', '--wait', '1m', '--json');
  assert.equal(waited.status, 0, waited.stderr);
  assert.doesNotMatch(waited.stderr, /ExperimentalWarning/);
  const first = JSON.parse(waited.stdout);
  assert.equal(first.run.status, 'completed');
  assert.deepEqual(first.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
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
    if (steps[9].status === 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.deepEqual(steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'running']);
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
  assert.deepEqual(k.steps.map((s) => s.status), ['completed', 'completed', ...Array(7).fill('pending'), 'interrupted']);
  assert.match(killed.stderr, new RegExp(`^next: learn-from-mistakes-axi rerun --resume --run ${run.id}   # finish it`, 'm'));

  const next = lfm('retro', '--wait', '--json'); // the interrupted run blocks nothing; a bare --wait waits 8 minutes
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).run.status, 'completed');

  const resumed = lfm('rerun', '--resume', '--run', String(run.id), '--wait', '1m', '--json');
  assert.equal(resumed.status, 0, resumed.stderr);
  const r = JSON.parse(resumed.stdout);
  assert.equal(r.run.status, 'completed');
  assert.equal(r.run.error, null);
  assert.deepEqual(r.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
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
    /^bundle: bundle\.md: \d+ items, 0 dropped, \d+ characters$/, /^report: running$/, /^report: repeated: /, /^report: completed$/, /^run:$/];
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
  assert.match(nope.stderr, new RegExp(`^error: run ${first.id} has no step "judge" \\(steps: collect, metrics, followup, bundle, analyse, propose, verify, check, apply, report\\)$`, 'm'));

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
  assert.deepEqual(a.steps.map((s) => s.status), ['completed', 'completed', ...Array(7).fill('pending'), 'cancelled']); // a cancelled run keeps no verdict either
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
  assert.deepEqual([r.run.status, ...r.steps.map((s) => s.status)], ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout).runs.map((x) => x.status), ['completed', 'cancelled', 'completed']);
});

// A copy of the examples with two defect records today, whose PATH holds only the fake agents, node for its #! line, and
// git: lfm(env, ...args) runs the CLI there, query reads the run store, calls(name) an agent's calls, lines(step, run) a step's log lines.
function agentSetup() {
  const { p, env } = setup();
  const bin = join(p, '..', 'bin'), log = join(p, '..', 'log');
  for (const d of [bin, log]) mkdirSync(d);
  for (const name of ['claude', 'codex']) symlinkSync(FAKE_AGENT, join(bin, name)); // the worker and the judge
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(bin, 'git'));
  appendFileSync(join(p, 'defects.md'), `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [tests] Umer's tests failed: UMER_FIXTURES was unset.\n- [tests] They failed again for the same reason.\n`);
  // The tool's git runs with PATH=bin only, so the host's global git config must not answer: a global hooksPath would
  // run hooks whose bash is not on that PATH, and a ref update (apply's git branch) would fail for the host, not the tool.
  const lfm = (extra, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, PATH: bin, FAKE_LOG: log, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra } });
  const query = (sql, ...args) => { const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(...args).map((x) => ({ ...x })); } finally { db.close(); } };
  const calls = (name = 'claude') => readFileSync(join(log, `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lines = (step, id) => JSON.parse(lfm({}, 'logs', '--step', step, '--run', String(id), '--json').stdout).log.map((l) => l.line);
  return { p, env, bin, lfm, query, calls, lines };
}
// True when a run stored no verdict, label, finding, fix or follow-up, and wrote no report.txt.
function nothingJudged(query, id) {
  return ['labels', 'findings', 'proposals', 'followups'].every((t) => query(`SELECT count(*) AS n FROM ${t} WHERE run_id = ?`, id)[0].n === 0)
    && query(`SELECT count(*) AS n FROM steps WHERE run_id = ? AND name IN ('followup', 'analyse', 'propose', 'verify', 'check', 'report') AND output_json IS NOT NULL`, id)[0].n === 0;
}
// A run's report.txt: the seven sections in order; each line a person reads has sentences of at most 20 words and no
// path or store id; each pointer on an Evidence line opens: a line of a project file, a gate store row or a session.
function reportOf(p, id) {
  const text = readFileSync(join(p, '.lfm', 'runs', String(id), 'report.txt'), 'utf8');
  const heads = text.split('\n').filter((l) => /^\d\. [A-Z][a-z ]+$/.test(l));
  assert.deepEqual(heads, ['1. Short answer', '2. Numbers', '3. Last changes', '4. Repeated mistakes', '5. Fixes', '6. Not checked', '7. Questions for you']);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true }), gate = new DatabaseSync(join(p, 'gate.sqlite'), { readOnly: true });
  try {
    for (const line of text.split('\n')) {
      const ap = /^ {3}applied: fix \d+:\d+ on branch lfm\/\d+-\d+, commit ([0-9a-f]{12}), ledger (chg-\d+)$/.exec(line); // a fix the run applied: its ledger entry opens
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
  assert.deepEqual(steps.map((s) => [s.name, s.status]).slice(3), [['bundle', 'completed'], ['analyse', 'completed'], ['propose', 'completed'], ['verify', 'completed'], ['check', 'completed'], ['apply', 'completed'], ['report', 'completed']]);
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
  assert.deepEqual(JSON.parse(query(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'analyse'`, run.id)[0].output_json), { asked: true, labels: 2, labels_dropped: 0, findings: 1, problems: 1 });
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
  assert.deepEqual(b.steps.map((s) => s.status), ['completed', 'completed', 'pending', 'pending', 'failed', 'pending', 'pending', 'pending', 'pending', 'pending']);
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
  // each finding and fix as a claim with its refs, then the bundle. Its verdicts land on the rows.
  const [judge] = calls('codex');
  assert.equal(realpathSync(judge.cwd), realpathSync(join(p, '.lfm', 'runs', String(run.id))));
  assert.deepEqual(judge.args.slice(0, 3), ['exec', '-m', 'gpt-6-luna']);
  assert.ok(judge.stdin.startsWith(`lfm-run:${run.id}:verify\nYou are the judge of a retro.`), judge.stdin.slice(0, 200));
  assert.match(judge.stdin, /The worker's claims are not evidence\./);
  assert.match(judge.stdin, /^- f1: finding for cause umer-fixtures-unset\. The tests fail when UMER_FIXTURES is unset\. No doc names it\. Refs: \S+\.$/m);
  assert.match(judge.stdin, /^- p2: fix for cause shared-cache-lock\. Target: launch script 2\. Owner: maintainer\. Change: .+ Metric: cause_count:shared-cache-lock\. Tripwire: <= 0\. Refs: .+\.$/m);
  assert.ok(judge.stdin.endsWith(readFileSync(join(p, '.lfm', 'runs', String(run.id), 'bundle.md'), 'utf8')), 'the bundle is not the end of the prompt');
  assert.ok(!calls().some((c) => c.stdin.includes(':verify\n')), 'the worker was asked to judge');
  assert.deepEqual(query(`SELECT role, runner, model, exit_status FROM invocations WHERE run_id = ? AND step = 'verify'`, run.id), [{ role: 'judge', runner: 'codex', model: 'gpt-6-luna', exit_status: 'ok' }]);
  assert.deepEqual(query('SELECT verdict, judge_note FROM findings WHERE run_id = ?', run.id), [{ verdict: 'confirmed', judge_note: 'The cited items show this for Umer.' }]);
  assert.deepEqual(query('SELECT verdict FROM proposals WHERE run_id = ? ORDER BY id', run.id).map((f) => f.verdict), ['confirmed', 'refuted', 'weakened', ...Array(5).fill('confirmed')]);
  assert.deepEqual(lines('verify', run.id), ['judge codex gpt-6-luna: answered', 'refuted: p2', 'weakened: p3', 'verdicts: 7 confirmed, 1 weakened, 1 refuted']);
  // The worker got the causes with their counts, the kept finding and the propose method, then the bundle.
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
    [null, 'test setup', 'cause_count:umer-fixtures-unset', '<= 0', 1], [null, 'cache config', 'cause_count:shared-cache-lock', null, 1]]);
  assert.deepEqual(fixes, [1, 2, 3, 4, 5].map((n) => ({ n, cause: 'shared-cache-lock', metric: n === 1 ? 'defects' : 'cause_count:shared-cache-lock', tripwire: '<= 0', verdict: n === 5 ? 'weakened' : 'confirmed' })));
  assert.deepEqual(query('SELECT cause, count, days FROM findings WHERE run_id = ?', run.id), [{ cause: 'umer-fixtures-unset', count: 1, days: 1 }]);
  // report.txt: the kept fixes with the judge's verdict and note, what was not checked, and with no sign-off-axi an Apply or Skip question per fix.
  const text = reportOf(p, run.id);
  assert.match(text, /^- 2 mistakes came back in this window\.\n- 5 fixes passed the rules\. The judge confirmed 4 of them\.\n- 1 metric missed the target\.$/m);
  assert.match(text, /^- defects: this window 2, last window 0, target <= 0, missed\.$/m);
  assert.match(text, /^- shared-cache-lock: 2 times on 1 day\.\n {3}Evidence: defects\.md:\d+; defects\.md:\d+$/m);
  assert.match(text, /^Fix 5, for shared-cache-lock:\n[\s\S]*?^- Change:\n {2}Give each worker its own cache directory\.\n[\s\S]*?^- The judge's verdict: weakened\.\n {2}The cited items show this only once for Umer\.$/m);
  assert.match(text, /^6\. Not checked\n- The rules left out 3 fixes\.\n- The judge weakened 1 item\.$/m);
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
  assert.match(reportOf(p, second.id), /^3\. Last changes\n- Change chg-1, metric defects: 2 before, 0 after\. The verdict is no-data\. Wait for more data\.\n {2}Too few sessions ran after the change for Umer\.\n\n4\.[\s\S]*^7\. Questions for you\n- No questions\.\n$/m);
  assert.deepEqual(lines('verify', second.id), ['nothing to verify: no finding and no fix']);
  assert.deepEqual(lines('check', second.id), ['fixes: 0 kept of 0, problems: 0']);
});

test('signoff post without the peer prints keys only: a canary change sentence reaches report.txt, never stdout', () => {
  const { p, lfm } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const canary = 'CANARY-signoff-fallback-7q2x';
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_CANARY: canary }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run } = JSON.parse(r.stdout);
  const fallback = lfm({}, 'signoff', 'post');
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /kept: lfm-\d+-\d+-[0-9a-f]{8}/);
  assert.ok(!fallback.stdout.includes(canary), 'fallback stdout carries the change text');
  assert.ok(!fallback.stdout.includes('Repeated cause:'));
  assert.ok(!fallback.stdout.includes('Give each worker its own cache directory'));
  assert.ok(readFileSync(join(p, '.lfm', 'runs', String(run.id), 'report.txt'), 'utf8').includes(canary), 'report.txt lost the fix text');
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
  const commit = git('rev-parse', `lfm/${run.id}-1`); assert.equal(ok.stdout, `applied: fix ${run.id}:1 on branch lfm/${run.id}-1, commit ${commit.slice(0, 12)}, ledger chg-1\n`);
  assert.match(ok.stderr, new RegExp(`^next: git diff HEAD\\.\\.\\.lfm/${run.id}-1   # review it`, 'm'));
  // The branch holds one commit on HEAD with the worker's edit; the user's branch, index and work tree are untouched.
  assert.deepEqual([git('rev-parse', `lfm/${run.id}-1^`), git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')], [head, head, 'main', '?? notes.txt']);
  rmSync(join(p, 'notes.txt')); assert.equal(readFileSync(join(p, 'AGENTS.md'), 'utf8'), rules);
  assert.equal(git('show', `lfm/${run.id}-1:AGENTS.md`), `${rules}- Give each worker its own cache directory, Umer.`);
  assert.equal(git('show', `lfm/${run.id}-1:defects.md`), `${defects}- Give each worker its own cache directory, Umer.`);
  assert.deepEqual(git('diff', '--name-only', `HEAD..lfm/${run.id}-1`), 'AGENTS.md\ndefects.md');
  // One fresh tool-off call to the worker, never the judge, with the fix and both files: no bundle and no record text beyond the files.
  const call = calls().at(-1); assert.equal(calls().length, before + 1);
  assert.ok(call.stdin.startsWith(`lfm-run:${run.id}:apply-1\nYou are the worker of a retro. The user accepted the fix below.`), call.stdin.slice(0, 200));
  assert.ok(call.args.includes('--tools') && call.stdin.includes(`--- AGENTS.md\n${rules}\n--- end of AGENTS.md`) && call.stdin.includes(`--- defects.md\n${defects}\n--- end of defects.md`) && !call.stdin.includes('# Retro bundle'));
  // The log records live in defects.md, so they arrive with that target file; every other source's record text stays out.
  for (const { text } of query(`SELECT text FROM records WHERE run_id = ? AND source != 'log'`, run.id)) assert.ok(!call.stdin.includes(text.trim()), 'record text reached the apply call');
  assert.ok(!calls('codex').some((c) => c.stdin.includes(':apply-')), 'the judge applied a fix');
  assert.deepEqual(query(`SELECT role, runner, exit_status FROM invocations WHERE run_id = ? AND step = 'apply-1'`, run.id), [{ role: 'worker', runner: 'claude', exit_status: 'ok' }]);
  const [chg] = JSON.parse(lfm({}, 'changes', '--json').stdout).changes; assert.deepEqual([chg.id, chg.cause, chg.ref, chg.kind, chg.what], ['chg-1', 'shared-cache-lock', commit, 'code', `fix ${run.id}:1 on branch lfm/${run.id}-1`]);
  assert.equal(lfm({}, 'apply').stdout, ok.stdout); assert.equal(calls().length, before + 1);
  { // a reused run id with the same cause and change text but another target is refused, never reported applied
    const reuse = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
    try { reuse.prepare(`UPDATE proposals SET target = 'defects.md' WHERE run_id = ? AND n = 1`).run(run.id); } finally { reuse.close(); }
    const other = lfm({}, 'apply', '--fix', '1'); assert.equal(other.status, 1, other.stderr);
    assert.match(other.stderr, new RegExp(`^error: branch lfm/${run.id}-1 holds [0-9a-f]{7} instead of the fix ${run.id}:1 apply commit\nnext: git branch -D lfm/${run.id}-1`, 'm'));
    assert.equal(git('rev-parse', `lfm/${run.id}-1`), commit, 'a refused reuse must not move the branch');
    assert.equal(calls().length, before + 1, 'a refused reuse must not call the worker');
    const restore = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
    try { restore.prepare(`UPDATE proposals SET target = 'AGENTS.md:12 and defects.md' WHERE run_id = ? AND n = 1`).run(run.id); } finally { restore.close(); }
  }
  git('branch', '-f', `lfm/${run.id}-1`, git('commit-tree', `${head}^{tree}`, '-p', head, '-m', `learn-from-mistakes: fix ${run.id}:1 for slow-build\n\nRebuild the Go binary before the gate.`));
  const stale = lfm({}, 'apply', '--fix', '1'); assert.equal(stale.status, 1, stale.stderr); assert.match(stale.stderr, new RegExp(`^error: branch lfm/${run.id}-1 holds [0-9a-f]{7} instead of the fix ${run.id}:1 apply commit\nnext: git branch -D lfm/${run.id}-1`, 'm'));
  for (const [n, code, error] of [[2, 2, `fix ${run.id}:2 was answered Skip, and a Skip is never applied`], [3, 1, `fix ${run.id}:3 names no tracked file in its target "the launch script", so the worker has nothing to edit`], [9, 2, `run ${run.id} has no kept fix 9`]]) {
    const r = lfm({}, 'apply', '--fix', String(n)); assert.equal(r.status, code, r.stderr); assert.match(r.stderr, new RegExp(`^error: ${error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.ok(!git('branch', '--list', 'lfm/*').includes('-2') && JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length === 1);
  auto(-1); assert.match(lfm({}, 'apply').stderr, /auto_fix must be a whole number, 0 or more \(0 = propose only\)/);
  writeFileSync(global, readFileSync(global, 'utf8').replace('auto_fix: -1', 'auto_fix: 1'));
  const auto1 = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout), branch = `lfm/${auto1.run.id}-1`, commit2 = git('rev-parse', branch);
  assert.deepEqual([auto1.run.status, git('rev-parse', `${branch}^`), git('branch', '--show-current'), git('status', '--porcelain')], ['completed', head, 'main', '']);
  assert.deepEqual(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.map((c) => [c.id, c.ref]), [['chg-1', commit], ['chg-2', commit2]]);
  // The run applies fix 1 before its report: report.txt and signoff post name it as applied and ask only about the rest.
  const done = `applied: fix ${auto1.run.id}:1 on branch ${branch}, commit ${commit2.slice(0, 12)}, ledger chg-2`, report = reportOf(p, auto1.run.id);
  assert.deepEqual(asked(auto1.run.id), [`   ${done}`, ...[2, 3, 4, 5].map((n, i) => `${i + 1}. Apply fix ${n}, for shared-cache-lock? Answer Apply or Skip.`)]);
  const post = lfm({}, 'signoff', 'post', '--run', String(auto1.run.id)); assert.equal(post.status, 0, post.stderr);
  assert.deepEqual([post.stdout.split('\n')[0], [...post.stdout.matchAll(/^kept: lfm-\d+-(\d+)-/gm)].map((m) => m[1])], [done, ['2', '3', '4', '5']]);
  // A run saved before apply moved ahead of report (report ord 8, apply ord 9) resumes in today's order: apply, then report again.
  const old = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  try { old.exec(`UPDATE steps SET ord = 17 - ord, status = CASE name WHEN 'apply' THEN 'failed' ELSE status END WHERE run_id = ${auto1.run.id} AND name IN ('report', 'apply'); UPDATE runs SET status = 'failed' WHERE id = ${auto1.run.id}`); } finally { old.close(); }
  rmSync(join(p, '.lfm', 'runs', String(auto1.run.id), 'report.txt')); const before2 = calls().length;
  const resumed = lfm(fake, 'rerun', '--resume', '--run', String(auto1.run.id), '--wait', '1m', '--json'); assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).steps.slice(-2).map((s) => [s.name, s.status]), [['apply', 'completed'], ['report', 'completed']]);
  assert.deepEqual([reportOf(p, auto1.run.id), calls().length], [report, before2], 'the branch is kept, so the worker is not called again');
});

test('apply: a cut-off reply is refused with no branch and no ledger change; trailing-newline-only and normal-stop replies still apply', () => {
  const { p, lfm, calls, git, fake } = applyRepo();
  const rules = '# Rules\n\n- Run the tests before a PR.\n'; const head = git('rev-parse', 'HEAD');
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  // two ways a cut-off reply shows: FAKE_APPLY=cut returns text cut mid-line (no stop reason reported), length returns
  // whole file text with the stop_reason a length cut carries. Both are refused: the file and reason are named, no branch
  // is created or moved, changes.jsonl gets no row, and the worker is not sent back to try again (one call, then refused).
  for (const mode of ['cut', 'length']) {
    const before = calls().length;
    const r = lfm({ FAKE_APPLY: mode }, 'apply', '--fix', '1');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^error: fix ${run.id}:1: the worker's reply for .+ was cut off \\(.+; apply refuses to commit an incomplete file$`, 'm'));
    assert.match(r.stderr, /^next: learn-from-mistakes-axi apply --fix 1   # the worker hit its output limit/m);
    assert.equal(git('branch', '--list', 'lfm/*'), '', `${mode}: a cut-off reply creates no branch`);
    assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 0, `${mode}: a cut-off reply records no ledger change`);
    assert.equal(calls().length, before + 1, `${mode}: exactly one worker call, then refused, never sent back`);
  }
  // A whole-file reply is still applied on its branch from HEAD and recorded; the work tree is untouched.
  const ok = lfm({}, 'apply', '--fix', '1'); assert.equal(ok.status, 0, ok.stderr);
  const commit = git('rev-parse', `lfm/${run.id}-1`);
  assert.equal(ok.stdout, `applied: fix ${run.id}:1 on branch lfm/${run.id}-1, commit ${commit.slice(0, 12)}, ledger chg-1\n`);
  assert.deepEqual([git('rev-parse', `lfm/${run.id}-1^`), git('branch', '--show-current'), git('status', '--porcelain')], [head, 'main', '']);
  assert.equal(readFileSync(join(p, 'AGENTS.md'), 'utf8'), rules, 'the work tree is untouched');
  assert.equal(git('show', `lfm/${run.id}-1:AGENTS.md`), `${rules}- Give each worker its own cache directory, Umer.`);
  assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 1, 'after two refusals, exactly one applied change is recorded');
  // A whole reply that only removes the trailing newline still applies on a fresh branch.
  const trail = lfm({ FAKE_APPLY: 'trailing' }, 'apply', '--fix', '2'); assert.equal(trail.status, 0, trail.stderr);
  assert.equal(git('show', `lfm/${run.id}-2:AGENTS.md`), rules.replace(/\n$/, ''));
  // A runner-reported normal stop is the runner's own word the reply is whole, so an oddly-shaped reply applies.
  const normal = lfm({ FAKE_APPLY: 'cut', FAKE_STOP: 'end_turn' }, 'apply', '--fix', '3'); assert.equal(normal.status, 0, normal.stderr);
  assert.ok(git('rev-parse', `lfm/${run.id}-3`).length > 0, 'a normal stop applies an oddly-shaped reply');
  // A length stop always refuses, even with whole file text: no branch, no ledger change.
  const len = lfm({ FAKE_STOP: 'max_tokens' }, 'apply', '--fix', '4');
  assert.equal(len.status, 1, len.stderr);
  assert.match(len.stderr, new RegExp(`^error: fix ${run.id}:4: the worker's reply for .+ was cut off \\(.+; apply refuses to commit an incomplete file$`, 'm'));
  assert.equal(git('branch', '--list', `lfm/${run.id}-4`), '', 'a length stop creates no branch');
  // A big shrink refuses with its honest next step: name the removal, or edit by hand and record it.
  const shrink = lfm({ FAKE_APPLY: 'shrink' }, 'apply', '--fix', '5');
  assert.equal(shrink.status, 1, shrink.stderr);
  assert.match(shrink.stderr, new RegExp(`^error: fix ${run.id}:5: the worker's reply for .+ was cut off \\(the new text drops more than half the file`, 'm'));
  assert.match(shrink.stderr, new RegExp(`^next: name the removal in the change text, or make the edit by hand and record it with change applied --proposal ${run.id}:5 --ref <sha>`, 'm'));
  assert.equal(git('branch', '--list', `lfm/${run.id}-5`), '', 'a big shrink creates no branch');
  assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 3, 'the two refused fixes record nothing');
  const grownBefore = calls().length;
  const grown = lfm({ FAKE_APPLY: 'grown' }, 'apply', '--fix', '4');
  assert.equal(grown.status, 1, grown.stderr);
  assert.match(grown.stderr, new RegExp(`^error: fix ${run.id}:4: the worker's reply for .+ was cut off \\(it ends mid-line where the file ended with a newline`, 'm'));
  assert.equal(git('branch', '--list', `lfm/${run.id}-4`), '', 'a grown mid-line cut creates no branch');
  assert.equal(calls().length, grownBefore + 1, 'a grown cut is refused without a retry');
  const brokenBefore = calls().length;
  const broken = lfm({ FAKE_APPLY: 'broken' }, 'apply', '--fix', '5');
  assert.equal(broken.status, 1, broken.stderr);
  assert.match(broken.stderr, /^error: the worker's reply was cut off \(the reply stopped at "max_tokens"\)/m);
  assert.match(broken.stderr, /output limit/m);
  assert.match(broken.stderr, /^next: shorten the change or raise the model's output limit/m);
  assert.equal(git('branch', '--list', `lfm/${run.id}-5`), '', 'a cut JSON envelope creates no branch');
  assert.equal(calls().length, brokenBefore + 1, 'a cut envelope is refused without a retry');
  assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 3, 'the refused fixes record nothing');
});

test('auto_fix is a user setting: a project file that sets it exits 2 and a retro does not start', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `${readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8')}auto_fix: 3\n`);
  const r = lfm('retro', '--foreground'); assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: .*\.learn-from-mistakes\.yaml: auto_fix is global-only: set it in .*config\.yaml$/m);
  assert.ok(!existsSync(join(p, '.lfm', 'lfm.sqlite')), 'a refused config must not create the store');
});

test('apply: with no saved store, apply names the empty store and exits 3', () => {
  const r = agentSetup().lfm({}, 'apply', '--run', '1'); assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /^error: no retro run has kept fixes$/m);
});

// A refused auto_fix must not hide in apply.log: the retro output and report.txt carry the refusal and its next.
test('auto_fix with no git identity: the retro output and report name the refusal and its next', () => {
  const s = applyRepo(); const { p, lfm, lines, git, fake, auto } = s;
  const lonely = join(p, '..', 'git-home'); mkdirSync(lonely); // a throwaway HOME and XDG: the host's git config must not answer here
  Object.assign(s.env, { HOME: lonely, XDG_CONFIG_HOME: lonely, GIT_CONFIG_NOSYSTEM: '1' });
  git('config', '--unset', 'user.name'); git('config', '--unset', 'user.email');
  auto(1);
  const out = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  assert.equal(out.run.status, 'completed', out.run.error);
  assert.deepEqual(out.refused, [{ fix: 1, why: 'git commit-tree: Author identity unknown', next: 'git config user.name "<name>" && git config user.email "<email>"   # apply signs each fix commit' }]);
  assert.deepEqual(JSON.parse(lfm({}, 'status', '--run', String(out.run.id), '--json').stdout).refused, out.refused);
  const report = reportOf(p, out.run.id);
  assert.match(report, new RegExp(`^ {3}refused: fix ${out.run.id}:1 was not applied: git commit-tree: Author identity unknown$`, 'm'));
  assert.match(report, /^ {3}next: git config user\.name "<name>" && git config user\.email "<email>"   # apply signs each fix commit$/m);
  assert.match(lines('apply', out.run.id).join('\n'), new RegExp(`^refused: fix ${out.run.id}:1 was not applied: git commit-tree: Author identity unknown$`, 'm'));
  // With the identity back the refused fix applies by hand, and a fresh auto_fix run applies inside the run again.
  git('config', 'user.name', 'Umer'); git('config', 'user.email', 'umer@example.com');
  const byHand = lfm({}, 'apply', '--run', String(out.run.id), '--fix', '1');
  assert.equal(byHand.status, 0, byHand.stderr);
  assert.match(byHand.stdout, new RegExp(`^applied: fix ${out.run.id}:1 on branch lfm/${out.run.id}-1`, 'm'));
  const again = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  assert.equal(again.refused, undefined);
  assert.match(lines('apply', again.run.id).join('\n'), /^applied: fix \d+:1 on branch lfm\/\d+-1, commit /m);
});

test('apply: with the judge unset and no kept fixes, it checks the store first and asks nothing', () => {
  const { p, env, lfm } = agentSetup();
  const global = join(env.LFM_HOME, 'config.yaml'), agentOnly = 'agent: claude\nagent_config: { claude: { model: claude-haiku-5-5 } }\n';
  writeFileSync(global, agentOnly); // the worker is set; no judge_agent anywhere, and no run has kept fixes
  const r = lfm({}, 'apply');
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /^error: no retro run has kept fixes$/m);
  assert.doesNotMatch(r.stderr, /ask the user|saved:/, 'apply asked for an agent a store with no kept fixes never uses');
  assert.equal(readFileSync(global, 'utf8'), agentOnly, 'apply saved the judge');
  assert.ok(!existsSync(join(p, '.lfm')), 'apply wrote state before it checked the store');
});

test('apply: with kept fixes and both roles unset, its gap names only the worker, never the judge', () => {
  const { global, lfm, fake } = applyRepo();
  const retro = lfm(fake, 'retro', '--foreground', '--json'); assert.equal(retro.status, 0, retro.stderr);
  writeFileSync(global, '{}\n'); // neither role is set anywhere, and the store already holds kept fixes
  const r = lfm({}, 'apply');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: ask the user which agent to use: agent is not set in \S+\.learn-from-mistakes\.yaml, and the tool never picks one\./m);
  assert.match(r.stderr, /^next: learn-from-mistakes-axi init --agent <agent> --model <model> --dir \S+   # with the user's answer$/m);
  assert.doesNotMatch(r.stderr, /judge/, 'apply asked for a judge it never starts');
});

test('apply: a refused apply in the run logs one line and the run stays ok with its proposals', () => {
  const { p, lfm, query, lines, git, fake, auto } = applyRepo(); auto(1);
  writeFileSync(join(p, 'AGENTS.md'), `${readFileSync(join(p, 'AGENTS.md'), 'utf8')}- Unfinished.\n`); // the user's uncommitted work refuses the apply
  const r = lfm(fake, 'retro', '--foreground', '--json'); assert.equal(r.status, 0, r.stderr);
  const { run } = JSON.parse(r.stdout); assert.equal(run.status, 'completed'); assert.equal(git('branch', '--list', 'lfm/*'), '');
  const refused = lines('apply', run.id); assert.equal(refused.length, 1, refused.join('\n'));
  assert.match(refused[0], new RegExp(`^refused: fix ${run.id}:1 was not applied: .* has uncommitted changes; apply never touches them$`));
  assert.ok(query('SELECT count(*) AS n FROM proposals WHERE run_id = ? AND n IS NOT NULL', run.id)[0].n > 0);
});

test('apply: a kept fix naming a cause that is not configured is refused in the run, with no branch', () => {
  const { p, lfm, lines, git, fake, auto } = applyRepo();
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.exec(`UPDATE proposals SET cause = 'unlisted-cause' WHERE run_id = ${run.id} AND n = 1; UPDATE steps SET status = 'failed' WHERE run_id = ${run.id} AND name = 'apply'; UPDATE runs SET status = 'failed' WHERE id = ${run.id};`); db.close();
  auto(1);
  const r = lfm(fake, 'rerun', '--resume', '--run', String(run.id), '--wait', '1m', '--json'); assert.equal(r.status, 0, r.stderr);
  const resumed = JSON.parse(r.stdout); assert.equal(resumed.run.status, 'completed');
  const refused = lines('apply', run.id); assert.equal(refused.length, 1, refused.join('\n'));
  assert.match(refused[0], new RegExp(`^refused: fix ${run.id}:1 was not applied: .* names cause unlisted-cause, which is not a configured cause$`));
  assert.equal(git('branch', '--list', 'lfm/*'), '');
});

test('apply: a target that is not valid UTF-8 is refused before the worker is asked; a valid UTF-8 target still applies', () => {
  const { p, lfm, calls, git, fake } = applyRepo();
  writeFileSync(join(p, 'notes-latin.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6c, 0x69, 0x6e, 0x65, 0x32, 0x0a]));
  git('add', '-A'); git('commit', '-qm', 'latin-1 target');
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  try { db.prepare(`UPDATE proposals SET target = 'notes-latin.txt' WHERE run_id = ? AND n = 1`).run(run.id); } finally { db.close(); }
  const before = calls().length;
  const refused = lfm({}, 'apply', '--fix', '1'); assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, new RegExp(`^error: fix ${run.id}:1 names notes-latin.txt, which is not valid UTF-8, so the worker cannot edit it$`, 'm'));
  assert.match(refused.stderr, /^next: convert notes-latin\.txt to UTF-8, then apply again$/m);
  assert.equal(git('branch', '--list', 'lfm/*'), '', 'a refused UTF-8 target must not create a branch');
  assert.equal(calls().length, before, 'a refused UTF-8 target must not call the worker');
  assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 0, 'a refused UTF-8 target must not record a ledger entry');
  const ok = lfm({}, 'apply', '--fix', '2'); assert.equal(ok.status, 0, ok.stderr);
  const commit = git('rev-parse', `lfm/${run.id}-2`);
  assert.equal(ok.stdout, `applied: fix ${run.id}:2 on branch lfm/${run.id}-2, commit ${commit.slice(0, 12)}, ledger chg-1\n`);
  assert.ok(!git('branch', '--list', 'lfm/*').includes(`lfm/${run.id}-1`), 'the refused fix must still have no branch');
});

test('apply: a target over caps.bundle_chars is refused before the worker is asked and before any branch', () => {
  const { p, lfm, calls, lines, git, fake, auto } = applyRepo();
  writeFileSync(join(p, 'big.txt'), 'line of target text\n'.repeat(4000)); // ~80k chars, over the 60000 cap
  git('add', '-A'); git('commit', '-qm', 'big target');
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  try { db.prepare(`UPDATE proposals SET target = 'big.txt' WHERE run_id = ? AND n = 1`).run(run.id); } finally { db.close(); }
  const size = readFileSync(join(p, 'big.txt'), 'utf8').length;
  assert.ok(size > 60000, `the target must clear the cap, got ${size}`);
  const before = calls().length;
  const refused = lfm({}, 'apply', '--fix', '1'); assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, new RegExp(`^error: fix ${run.id}:1 names a file totalling ${size} characters, over the caps.bundle_chars cap of 60000: big.txt \\(${size}\\)$`, 'm'));
  assert.match(refused.stderr, new RegExp(`^next: narrow the fix target to fewer files, or make the change by hand and record it with change applied --proposal ${run.id}:1 --ref <sha>, then apply again$`, 'm'));
  assert.equal(git('branch', '--list', 'lfm/*'), '', 'a refused cap target must not create a branch');
  assert.equal(calls().length, before, 'a refused cap target must not call the worker');
  assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 0, 'a refused cap target must not record a ledger entry');
  const reopen = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  try { reopen.exec(`UPDATE steps SET status = 'failed' WHERE run_id = ${run.id} AND name = 'apply'; UPDATE runs SET status = 'failed' WHERE id = ${run.id};`); } finally { reopen.close(); }
  auto(1);
  const r = lfm(fake, 'rerun', '--resume', '--run', String(run.id), '--wait', '1m', '--json'); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).run.status, 'completed');
  const logged = lines('apply', run.id); assert.equal(logged.length, 1, logged.join('\n'));
  assert.match(logged[0], new RegExp(`^refused: fix ${run.id}:1 was not applied: fix ${run.id}:1 names a file totalling ${size} characters, over the caps.bundle_chars cap of 60000`));
  assert.equal(git('branch', '--list', 'lfm/*'), '', 'a refused cap target must not create a branch in the run either');
});

test('apply: a worker that answers no JSON fails the fix in the run as failed:, with no branch', () => {
  const { p, lfm, calls, lines, git, fake, auto } = applyRepo();
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  try { db.exec(`UPDATE steps SET status = 'failed' WHERE run_id = ${run.id} AND name = 'apply'; UPDATE runs SET status = 'failed' WHERE id = ${run.id};`); } finally { db.close(); }
  auto(1);
  const before = calls().length;
  const r = lfm({ ...fake, FAKE_APPLY: 'nojson' }, 'rerun', '--resume', '--run', String(run.id), '--wait', '1m', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).run.status, 'completed');
  const failed = lines('apply', run.id); assert.equal(failed.length, 5, failed.join('\n')); // two answers, two sent-back, one failed:
  assert.match(failed.at(-1), new RegExp(`^failed: fix ${run.id}:1 was not applied: the worker's answer is not valid after one retry: the answer holds no JSON object$`));
  assert.equal(calls().length, before + 2, 'a bad answer is sent back once, then the fix fails');
  assert.equal(git('branch', '--list', 'lfm/*'), '', 'a failed worker call creates no branch');
  assert.equal(JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length, 0, 'a failed worker call records no ledger entry');
  const direct = lfm({ FAKE_APPLY: 'nojson' }, 'apply', '--fix', '2'); // direct apply keeps the usage error, not a crash
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(direct.stderr, /^error: the worker's answer is not valid after one retry: the answer holds no JSON object$/m);
  assert.match(direct.stderr, /^next: learn-from-mistakes-axi --help/m);
});

test('retro and rerun stop before a run when the judge is not ready; a judge on the worker\'s agent and model runs, in its own session', () => {
  const { p, env, lfm, lines } = agentSetup();
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), `agent: claude\njudge_agent: acp:claude\nagent_config: { claude: { model: claude-haiku-5-5 }, "acp:claude": { model: claude-haiku-5-5 } }\n`);
  for (const cmd of ['retro', 'rerun']) {
    const r = lfm({}, cmd);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /^error: judge: acp:claude is not usable: acpx is not on PATH$/m);
  }
  assert.ok(!existsSync(join(p, '.lfm', 'lfm.sqlite')), 'a run started');
  // The user's choice: one agent and model in both roles. Nothing refuses it; the judge still checks every claim.
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), `agent: claude\njudge_agent: claude\nagent_config: { claude: { model: claude-haiku-5-5 } }\n`);
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.run.status, 'completed');
  assert.match(lines('verify', out.run.id)[0], /^judge claude claude-haiku-5-5: answered/);
  assert.ok(out.fixes.length && out.fixes.every((f) => f.verdict === 'confirmed'), r.stdout);
});

test('a judge that leaves a claim without a verdict, or fails, fails the run: it keeps no verdict, label, finding, fix or report; a resume runs from followup', () => {
  const { p, lfm, query, lines } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const agents = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight' };
  const why = "the judge's answer is not valid after one retry: verdicts has no verdict for p1";
  const left = lfm({ ...agents, FAKE_UNJUDGED: 'p1' }, 'retro', '--foreground', '--json');
  assert.equal(left.status, 1, left.stderr);
  const l = JSON.parse(left.stdout);
  assert.equal(l.run.error, `verify: ${why}`);
  assert.deepEqual(lines('verify', l.run.id), ['judge codex gpt-6-luna: answered', 'judge answer 1 is not valid: verdicts has no verdict for p1', 'judge codex gpt-6-luna: answered',
    'judge answer 2 is not valid: verdicts has no verdict for p1', `error: ${why}`]);
  assert.equal(nothingJudged(query, l.run.id), true);
  assert.deepEqual([l.followups, l.fixes, l.result, existsSync(join(p, '.lfm', 'runs', String(l.run.id), 'report.txt'))], [undefined, undefined, undefined, false]);
  assert.match(left.stderr, new RegExp(`^next: learn-from-mistakes-axi rerun --resume --run ${l.run.id}   # finish it after fixing the verify step`, 'm'));
  // A judge whose call fails: the same, with the agent's own error as the cause.
  const crashed = lfm({ ...agents, FAKE_JUDGE: 'fail' }, 'retro', '--foreground', '--json');
  assert.equal(crashed.status, 1, crashed.stderr);
  const c = JSON.parse(crashed.stdout);
  assert.match(c.run.error, /^verify: .*the judge crashed for Umer/);
  assert.equal(nothingJudged(query, c.run.id), true);
  const report = lfm({}, 'report'); // no run completed, so there is no report to show
  assert.equal(report.status, 3, report.stderr);
  assert.match(report.stderr, /^error: no completed runs in /m);
  // With the judge working again, the resume runs from the followup step and every kept fix carries a verdict.
  const resumed = lfm(agents, 'rerun', '--resume', '--run', String(c.run.id), '--wait', '1m', '--json');
  assert.equal(resumed.status, 0, resumed.stderr);
  const r = JSON.parse(resumed.stdout);
  assert.deepEqual([r.run.status, ...r.steps.map((s) => s.status)], ['completed', ...Array(10).fill('completed')]);
  assert.deepEqual(r.fixes.map((f) => f.verdict), Array(5).fill('confirmed'));
  assert.equal(query('SELECT count(*) AS n FROM proposals WHERE run_id = ? AND verdict IS NULL', c.run.id)[0].n, 0);
});

test('propose: a rule-breaking fix is sent back once, then dropped on the second answer while the valid fixes are kept; check counts nothing for a refuted finding', () => {
  const { p, lfm, query, calls, lines } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'long', FAKE_REFUTE: 'f1' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run } = JSON.parse(r.stdout);
  const asks = calls().filter((c) => c.stdin.startsWith(`lfm-run:${run.id}:propose\n`));
  assert.equal(asks.length, 2, 'the worker is asked once more, with the problem');
  assert.match(asks[1].stdin, /Your last answer was not valid: proposals\[1\]\.change has more than 3 sentences\./);
  assert.deepEqual(query('SELECT target FROM proposals WHERE run_id = ?', run.id), [{ target: 'launch script 1' }]);
  assert.ok(lines('propose', run.id).includes('dropped: proposals[1].change has more than 3 sentences'));
  assert.equal(lines('propose', run.id).at(-1), 'fixes: 1 proposed, reasons: 0 of 0 follow-ups');
  assert.deepEqual(query('SELECT verdict, count, days FROM findings WHERE run_id = ?', run.id), [{ verdict: 'refuted', count: null, days: null }]);
  assert.match(lfm({}, 'report').stdout, /^finding: umer-fixtures-unset \(0\/0 days, refuted\)$/m);
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

test('propose: a fix quoting record text is sent back once naming the field, then dropped, while a paraphrase is kept; with excerpts off the stored records still refuse it', () => {
  const { p, lfm, query, calls, lines } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }'));
  appendFileSync(join(p, 'defects.md'), `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [cache] The nightly backlog queue filled and blocked the morning release workers -> 1 h -> OPEN.\n- [cache] The nightly backlog queue filled and blocked the morning release workers again -> 2 h -> OPEN.\n`);
  const quoted = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'quote' };
  const r = lfm(quoted, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run } = JSON.parse(r.stdout);
  const asks = calls().filter((c) => c.stdin.startsWith(`lfm-run:${run.id}:propose\n`));
  assert.equal(asks.length, 2, 'the worker is asked once more, with the problem');
  assert.match(asks[1].stdin, /Your last answer was not valid: proposals\[0\]\.change quotes a record; rewrite it without quoting record text\./);
  const refusal = asks[1].stdin.match(/^Your last answer was not valid: (.*)\. Answer again with one JSON object that fixes this\./m)[1];
  assert.equal(refusal, 'proposals[0].change quotes a record; rewrite it without quoting record text');
  assert.doesNotMatch(refusal, /nightly backlog/, 'the refusal never echoes the quoted words');
  assert.deepEqual(query('SELECT target FROM proposals WHERE run_id = ?', run.id), [{ target: 'launch script 2' }]);
  assert.ok(lines('propose', run.id).includes('dropped: proposals[0].change quotes a record; rewrite it without quoting record text'));
  assert.deepEqual(lines('check', run.id), ['fixes: 1 kept of 1, problems: 0']);
  const text = reportOf(p, run.id);
  assert.match(text, /^Fix 1, for shared-cache-lock:\n[\s\S]*?^- Change:\n {2}Give each worker its own cache directory for every lane\.\n/m);
  assert.doesNotMatch(text, /nightly backlog/, 'no quoted record text reaches report.txt');

  // With excerpts off the bundle holds no record text, but the stored records still refuse the quote.
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}excerpts: off\n`);
  const off = lfm(quoted, 'retro', '--foreground', '--json');
  assert.equal(off.status, 0, off.stderr);
  const offId = JSON.parse(off.stdout).run.id;
  assert.doesNotMatch(readFileSync(join(p, '.lfm', 'runs', String(offId), 'bundle.md'), 'utf8'), /^  > /m);
  const retries = calls().filter((c) => c.stdin.startsWith(`lfm-run:${offId}:propose\n`));
  assert.equal(retries.length, 2, 'the worker is asked once more, with the problem');
  assert.match(retries[1].stdin, /Your last answer was not valid: proposals\[0\]\.change quotes a record; rewrite it without quoting record text\./);
  assert.deepEqual(query('SELECT target FROM proposals WHERE run_id = ?', offId), [{ target: 'launch script 2' }]);
  assert.doesNotMatch(reportOf(p, offId), /nightly backlog/);
});

test('a run id reused after the store is removed starts its step logs empty', () => {
  const { p, lfm } = setup();
  const first = JSON.parse(lfm('retro', '--wait', '1m', '--json').stdout);
  assert.equal(first.run.status, 'completed');
  for (const f of ['lfm.sqlite', 'lfm.sqlite-wal', 'lfm.sqlite-shm']) rmSync(join(p, '.lfm', f), { force: true });
  const again = JSON.parse(lfm('retro', '--wait', '1m', '--json').stdout);
  assert.equal(again.run.id, 1);
  assert.equal(again.run.status, 'completed');
  const log = JSON.parse(lfm('logs', '--step', 'collect', '--run', '1', '--json').stdout);
  assert.deepEqual([log.lines, log.log.length], ['2 total', 2]);
});

test('a pending step of a reused run id shows no lines from the earlier run', () => {
  const { p, lfm, env } = setup();
  const first = lfm('retro', '--wait', '1m', '--json');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).run.status, 'completed');
  for (const f of ['lfm.sqlite', 'lfm.sqlite-wal', 'lfm.sqlite-shm']) rmSync(join(p, '.lfm', f), { force: true });
  const started = spawnSync(process.execPath, [CLI, 'retro', '--json', '--dir', p], { encoding: 'utf8', env: { ...env, LFM_TEST_SLOW_STEP: 'collect:3000' } });
  assert.equal(started.status, 0, started.stderr);
  const { run } = JSON.parse(started.stdout);
  assert.equal(run.id, 1);
  const report = JSON.parse(lfm('logs', '--step', 'report', '--run', '1', '--json').stdout);
  assert.deepEqual([report.status, report.lines, report.log.length], ['pending', '0 total', 0]);
  assert.equal(lfm('attach').status, 0);
});

test('a retro --wait poll that meets a write lock held past busy_timeout waits for the next poll and prints the run', async () => {
  const { p, env } = setup();
  const child = spawn(process.execPath, [CLI, 'retro', '--wait', '1m', '--json', '--dir', p], { env: { ...env, LFM_TEST_SLOW_STEP: 'collect:9000' } });
  after(() => { try { child.kill('SIGKILL'); } catch {} }); // a failed assertion must not leave the child behind
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((r) => child.once('close', r));
  const file = join(p, '.lfm', 'lfm.sqlite');
  const collecting = () => { // false while the store is being made
    try { const db = new DatabaseSync(file, { readOnly: true }); try { return db.prepare(`SELECT status FROM steps WHERE name = 'collect'`).get()?.status === 'running'; } finally { db.close(); } } catch { return false; }
  };
  for (let i = 0; i < 100 && !collecting(); i++) await new Promise((r) => setTimeout(r, 200));
  const hold = new DatabaseSync(file); // the worker sleeps in collect, so only the --wait poll meets the lock
  hold.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
  await new Promise((r) => setTimeout(r, 6500));
  hold.exec('ROLLBACK');
  hold.close();
  const code = await deadline(closed, 90_000, () => `the retro --wait child did not exit in 90 s\nstdout: ${out}\nstderr: ${err}`);
  assert.equal(code, 0, err);
  assert.equal(JSON.parse(out).run.status, 'completed');
});

test('the CLI, its guide and the shipped skill say the user sets the agents: no auto, no default model, and the ask re-runs the command', () => {
  const { lfm, raw, env } = setup();
  rmSync(join(env.LFM_HOME, 'config.yaml'));
  const ask = lfm('retro', '--foreground');
  assert.equal(ask.status, 2, ask.stderr);
  assert.match(ask.stderr, /^error: ask the user which agent to use: /m);
  assert.match(ask.stderr, /Then run the command that stopped again/);
  const check = spawnSync(process.execPath, [new URL('../scripts/build-skill.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const skill = readFileSync(new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url), 'utf8');
  for (const text of [raw('--help').stdout, raw('guide').stdout, skill]) {
    assert.doesNotMatch(text, /\bauto\b/);
    assert.doesNotMatch(text, /default model|cheap model|cheap default|as the default/);
  }
  assert.match(raw('guide').stdout, /ask the user which agent to use[\s\S]*run the stopped command again/);
  assert.match(skill, /ask the user which agent to use[\s\S]*run the stopped command again/);
});

// Every model the user sets runs: no model name is refused, and the removed allow_premium key is an unknown key.
test('doctor accepts any model the user set, with no premium block; a config that still sets allow_premium is refused', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\nagent_config: { claude: { model: claude-opus-5-5 } }\n');
  const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker model');
  assert.deepEqual([line.level, line.detail], ['ok', 'claude-opus-5-5']);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\nallow_premium: true\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  assert.match(JSON.parse(r.stdout).checks.find((c) => c.label === 'config').detail, /\.learn-from-mistakes\.yaml: unknown key allow_premium$/);
});

// A pinned runner that is not offered names no other agent CLI, so the fix cannot lead to the judge's agent and model.
test('doctor names no other agent CLI for a pinned runner that is not offered', () => {
  const { p, lfm, env } = setup();
  const fakes = env.PATH.split(delimiter)[0];
  writeFileSync(join(fakes, 'gemini'), '#!/bin/sh\necho "1.0.0"\n');
  chmodSync(join(fakes, 'gemini'), 0o755);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\nagent: gemini\nagent_config: { gemini: { model: umer-gem-1 } }\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const line = JSON.parse(r.stdout).checks.find((c) => c.label === 'worker');
  assert.equal(line.level, 'fail');
  assert.match(line.detail, /^gemini is not offered: /);
  assert.match(line.fix, /ask the user which agent and model to use, then set agent and its agent_config model in /);
  assert.doesNotMatch(line.fix, /\bclaude\b|\bcodex\b|\bopencode\b|\bpi\b/); // no other CLI is named
});

// A pinned runner that is not on PATH names its own install fix even when a usable alternative exists.
test('doctor names the pinned runner\'s own install fix when it is not on PATH, not the usable alternative', () => {
  const { p, lfm, env } = setup();
  const missing = join(env.LFM_HOME, 'no-such-claude'); // codex stays usable: the alternative must not be named
  appendFileSync(join(env.LFM_HOME, 'config.yaml'), `agent_path_override: { claude: ${missing} }\n`);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const line = JSON.parse(r.stdout).checks.find((c) => c.label === 'worker');
  assert.equal(line.level, 'fail');
  assert.equal(line.detail, `claude is not usable: ${missing} is not on PATH`);
  assert.equal(line.fix, `install ${missing}, or set agent_path_override.claude in ${join(env.LFM_HOME, 'config.yaml')}`);
  assert.doesNotMatch(line.fix, /\bcodex\b/);
});

// An opencode custom provider can keep its key in the environment ({env:VAR} in opencode.json): auth list counts no
// credential for it, so doctor reads the config instead. The variable set is logged in; unset is still a real fail.
test('doctor counts an opencode env-key provider as logged in and keeps the fail for a real missing login', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-oc-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'p'), fakes = join(tmp, 'fakes'), home = join(tmp, 'home'), lfmHome = join(tmp, 'lfm-home'), log = join(tmp, 'log');
  cpSync(new URL('../examples', import.meta.url).pathname, p, { recursive: true });
  own(p);
  for (const d of [fakes, lfmHome, log, join(home, '.config', 'opencode')]) mkdirSync(d, { recursive: true });
  symlinkSync(FAKE_AGENT, join(fakes, 'claude'));
  writeFileSync(join(fakes, 'opencode'), `#!${process.execPath}\nconst a = process.argv.slice(2);\nrequire('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify(a) + '\\n');\nif (a[0] === '--version') console.log('9.9.9 (fake opencode)');\nelse if (a[0] === 'auth') console.log('0 credentials');\n`);
  for (const name of ['claude', 'opencode']) chmodSync(join(fakes, name), 0o755);
  writeFileSync(join(lfmHome, 'config.yaml'), 'agent: claude\njudge_agent: opencode\nagent_config: { claude: { model: claude-haiku-5-5 }, opencode: { model: zai/glm-flash } }\n');
  const config = join(home, '.config', 'opencode', 'opencode.json');
  const provider = (at) => writeFileSync(at, JSON.stringify({ provider: { zai: { options: { baseURL: 'https://provider.example/v4', apiKey: '{env:LFM_TEST_PROVIDER_KEY}' }, models: { 'glm-flash': {} } } } }));
  const env = { ...process.env, PATH: `${fakes}${delimiter}${process.env.PATH}`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), LFM_HOME: lfmHome, CALL_LOG: join(log, 'opencode.jsonl') };
  const login = (over = {}) => JSON.parse(spawnSync(process.execPath, [CLI, 'doctor', '--json', '--dir', p], { encoding: 'utf8', env: { ...env, ...over } }).stdout).checks.find((c) => c.label === 'judge login');
  assert.equal(login().level, 'fail'); // no config, no variable: the real missing login
  provider(config);
  const unset = login();
  assert.equal(unset.level, 'fail'); // the config names the variable but it is unset
  assert.equal(unset.detail, 'opencode auth list: not logged in');
  assert.equal(unset.fix, 'opencode auth login');
  const ok = login({ LFM_TEST_PROVIDER_KEY: 'dummy-value-never-a-real-key' }); // a dummy value is enough: only its presence is read
  assert.equal(ok.level, 'ok');
  assert.ok(ok.detail.endsWith(`provider zai key from env LFM_TEST_PROVIDER_KEY (${config}))`), ok.detail);
  // A project-level opencode.json decides the same way once the global one is gone.
  rmSync(config); provider(join(p, 'opencode.json'));
  assert.equal(login({ LFM_TEST_PROVIDER_KEY: 'dummy-value-never-a-real-key' }).level, 'ok');
  rmSync(join(p, 'opencode.json'));
  // The model itself is never called: the shim only ever saw --version and auth list.
  const calls = readFileSync(join(log, 'opencode.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(calls.every((a) => a[0] === '--version' || (a[0] === 'auth' && a[1] === 'list')), JSON.stringify(calls));
});

// With auto_fix the run's apply step commits each fix: doctor checks the author identity and names the git config fix.
test('doctor with auto_fix checks the git author identity and names git config user.name/user.email', () => {
  const { p, env } = setup();
  appendFileSync(join(env.LFM_HOME, 'config.yaml'), 'auto_fix: 1\n');
  const home2 = join(env.LFM_HOME, 'h'); mkdirSync(home2); // a throwaway HOME: the host's ~/.gitconfig must not answer here
  const gitEnv = { ...env, HOME: home2, XDG_CONFIG_HOME: home2, GIT_CONFIG_NOSYSTEM: '1' }; // nor a system-wide or XDG identity
  const git = (...args) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8', env: gitEnv });
  const line = () => JSON.parse(spawnSync(process.execPath, [CLI, 'doctor', '--json', '--dir', p], { encoding: 'utf8', env: gitEnv }).stdout).checks.find((c) => c.label === 'git identity');
  assert.equal(line(), undefined, 'no identity check outside a git repo');
  git('init', '-q', '-b', 'main');
  assert.equal(line().level, 'fail');
  assert.equal(line().detail, 'no git author identity: the apply step cannot commit a fix');
  assert.match(line().fix, /git config user\.name .*git config user\.email /);
  git('config', 'user.name', 'Umer'); git('config', 'user.email', 'umer@example.com');
  assert.equal(line().level, 'ok');
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), readFileSync(join(env.LFM_HOME, 'config.yaml'), 'utf8').replace('auto_fix: 1', 'auto_fix: 0'));
  assert.equal(line(), undefined, 'no identity check without auto_fix');
});

// detect() probes only the configured roles: with one configured agent, doctor runs --version and reads the login
// store of that agent alone. Every other agent CLI on PATH is recorded by its own shim and must stay untouched.
test('doctor with one configured agent never starts another agent CLI', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-detect-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'p'), fakes = join(tmp, 'fakes'), log = join(tmp, 'log'), home = join(tmp, 'home');
  cpSync(new URL('../examples', import.meta.url).pathname, p, { recursive: true });
  own(p);
  for (const d of [fakes, log, home, join(tmp, 'lfm-home')]) mkdirSync(d, { recursive: true });
  // Each shim records its own name and argv, then answers --version; a login probe is never reached (claude has none).
  const shim = `const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.CALL_LOG, name + '.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('9.9.9 (fake ' + name + ')'); process.exit(0); }
process.exit(0);`;
  for (const name of ['claude', 'codex', 'gemini', 'opencode', 'pi', 'acpx']) {
    writeFileSync(join(fakes, name), `#!${process.execPath}\n${shim}`);
    chmodSync(join(fakes, name), 0o755);
  }
  // One configured agent: claude in both roles, which doctor accepts. The tool probes no other runner.
  writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), 'agent: claude\njudge_agent: claude\nagent_config: { claude: { model: claude-haiku-5-5 } }\n');
  const env = { ...process.env, PATH: fakes, HOME: home, LFM_HOME: join(tmp, 'lfm-home'), CALL_LOG: log };
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json', '--dir', p], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(readdirSync(log).sort(), ['claude.jsonl']); // codex, gemini, opencode, pi and acpx were never started
});
