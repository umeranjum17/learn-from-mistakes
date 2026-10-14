// End-to-end: runs the real CLI on copies of the synthetic examples (state in the copy's .lfm/) with a throwaway LFM_HOME.
// The report is the privacy-bounded lfm-report.v1 (identifiers, counts and verdict words, never prose); lfm-changes.v1
// carries only the owner-written what/why of each applied change.
// LFM_CLI points the same journeys at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const inputs = (p) => [join(p, 'labels.jsonl'), join(p, 'proposals.jsonl')];
const report = (lfm, p, ...extra) => lfm('report', '--labels', inputs(p)[0], '--proposals', inputs(p)[1], ...extra);
// The TOON report's last stdout line is the `repeated:` summary, outside lfm-report.v1.
const summaryOf = (stdout) => stdout.trimEnd().split('\n').at(-1);
const toonBodyOf = (stdout) => { const lines = stdout.trimEnd().split('\n'); lines.pop(); return lines.join('\n') + '\n'; };

test('state lives in the project\'s own .lfm/, git-ignored by the tool, never in a commit', () => {
  const { p, lfm } = setup();
  const git = (...args) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const lfmDir = join(p, '.lfm');
  const change = lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234'); // a ledger write on a fresh project
  assert.equal(change.status, 0, change.stderr);
  assert.equal(readFileSync(join(lfmDir, '.gitignore'), 'utf8'), '*\n');
  const ingest = lfm('ingest');
  assert.equal(ingest.status, 0, ingest.stderr);
  assert.match(ingest.stdout, new RegExp(`state: ${lfmDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
  assert.match(readFileSync(join(lfmDir, 'records.jsonl'), 'utf8'), /"text":/); // full record text, so it must stay out of git
  cpSync(join(p, 'labels.jsonl'), join(lfmDir, 'labels.jsonl')); // the agent's default inputs live there too
  cpSync(join(p, 'proposals.jsonl'), join(lfmDir, 'proposals.jsonl'));
  assert.equal(lfm('report').status, 0);
  assert.deepEqual(readdirSync(lfmDir).sort(), ['.gitignore', 'changes.jsonl', 'labels.jsonl', 'proposals.jsonl', 'records.jsonl', 'rows.jsonl', 'sources.json']);
  const status = git('status', '--porcelain', '--untracked-files=all');
  assert.doesNotMatch(status, /\.lfm/, status);
  assert.match(status, /\?\? defects\.md/); // the project's own files still show: only .lfm is ignored
  assert.match(git('status', '--porcelain', '--ignored'), /^!! \.lfm\/$/m); // ignored, not merely absent
  assert.ok(!existsSync(join(p, '.gitignore')), 'the project\'s own .gitignore is never touched');

  const { p: q, lfm: lfmQ } = setup(); // a deficient owner .gitignore refuses every write, before any state
  const mine = Buffer.from('# mine\n!keep.md\n*.jsonl\n');
  mkdirSync(join(q, '.lfm'));
  writeFileSync(join(q, '.lfm', '.gitignore'), mine);
  for (const args of [['ingest'], ['change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234']]) {
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
    assert.equal(lfmQ('ingest').status, 0);
    assert.equal(lfmQ('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234').status, 0);
    assert.equal(readFileSync(join(q, '.lfm', '.gitignore'), 'utf8'), owned);
    assert.ok(existsSync(join(q, '.lfm', 'records.jsonl')));
  }

  rmSync(join(q, '.lfm'), { recursive: true }); // '*' un-ignored back is still committable, so refused
  mkdirSync(join(q, '.lfm'));
  const negated = Buffer.from('*\n!records.jsonl\n');
  writeFileSync(join(q, '.lfm', '.gitignore'), negated);
  for (const args of [['ingest'], ['change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234']]) {
    const r = lfmQ(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\.gitignore: does not ignore all of \.lfm, so state could be committed; make it contain the line \*/);
  }
  assert.ok(readFileSync(join(q, '.lfm', '.gitignore')).equals(negated));
  assert.deepEqual(readdirSync(join(q, '.lfm')), ['.gitignore']);

  rmSync(join(q, '.lfm'), { recursive: true }); // a .gitignore git would not read stops every write, before any state
  mkdirSync(join(q, '.lfm', '.gitignore'), { recursive: true });
  for (const args of [['ingest'], ['change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234']]) {
    const r = lfmQ(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\.gitignore: not a regular file, so git would not ignore the state/);
    assert.match(r.stderr, /^next: rm -r <project>\/\.lfm\/\.gitignore   # the tool then writes one that ignores all of \.lfm$/m);
  }
  assert.deepEqual(readdirSync(join(q, '.lfm')), ['.gitignore']);
  rmSync(join(q, '.lfm'), { recursive: true });
  writeFileSync(join(q, '.lfm'), 'a stray file'); // a non-directory .lfm is a usage error, never a stack trace
  const stray = lfmQ('ingest');
  assert.equal(stray.status, 2, stray.stderr);
  assert.match(stray.stderr, /\.lfm: cannot create the state dir \(EEXIST\)/);
  assert.match(stray.stderr, /^next: mv <project>\/\.lfm <elsewhere>   # free \.lfm for the state dir/m);
  assert.doesNotMatch(stray.stderr, /\n\s+at /);
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
  for (const dir of projects) assert.equal(run(dir, 'ingest').status, 0);
  for (const [i, dir] of projects.entries()) {
    const text = readFileSync(join(dir, '.lfm', 'records.jsonl'), 'utf8');
    assert.match(text, new RegExp(`only in ${'ab'[i]}`));
    assert.doesNotMatch(text, new RegExp(`only in ${'ba'[i]}`)); // the second ingest never overwrote the first
  }
  assert.equal(run(projects[0], 'change', 'applied', '--cause', 'flaky', '--ref', 'abc1234').status, 0);
  assert.equal(JSON.parse(run(projects[1], 'changes', '--json').stdout).changes.length, 0);

  mkdirSync(join(tmp, 'home'), { recursive: true });
  writeFileSync(join(tmp, 'home', 'config.yaml'), `${AGENTS_SET}state_root: ${join(tmp, 'root')}\n`);
  rmSync(join(projects[0], '.lfm'), { recursive: true });
  const r = run(projects[0], 'ingest');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /state: .*\/root\/shop\n/); // <state_root>/<name>
  assert.match(readFileSync(join(tmp, 'root', 'shop', 'records.jsonl'), 'utf8'), /only in a/);
  assert.ok(!existsSync(join(tmp, 'root', 'shop', '.gitignore')), 'the .gitignore is only for the in-project default');
  assert.ok(!existsSync(join(projects[0], '.lfm')), 'an override writes nothing into the project');
});

test('help, guide and version work without a project file', () => {
  const { raw } = setup();
  const h = raw('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /usage: learn-from-mistakes-axi/);
  assert.match(h.stdout, /guide.*ingest.*count.*report/s);
  assert.match(h.stdout, /next: learn-from-mistakes-axi guide/);
  const g = raw('guide'); // the agent procedure lives in the CLI, not in the installed skill
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /\.learn-from-mistakes\.yaml.*records\.jsonl.*labels\.jsonl.*proposals\.jsonl/s);
  assert.match(g.stdout.trim().split('\n').at(-1), /^next: learn-from-mistakes-axi ingest/);
  const bare = raw(); // no config: point the agent at the guide
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /no \.learn-from-mistakes\.yaml/);
  assert.match(bare.stderr, /next: learn-from-mistakes-axi guide/);
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
  // A markdown-log-only project never loads node:sqlite, so ingest and report stay quiet too.
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  for (const r of [lfm('ingest'), lfm('report'), lfm('changes')]) {
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning/);
  }
});

test('every rejected input names what was wrong and a next step, never the whole usage', () => {
  const { p, lfm, raw } = setup();
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'bad.jsonl'), '{"id":"x"}\n{not json\n');
  const HELP = /^next: learn-from-mistakes-axi --help   # supported commands and options$/m;
  const CHANGE = /^next: learn-from-mistakes-axi change applied \(--cause <cause> \| --proposal <run>:<n>\) --ref <ref> \[--metric <metric>\] \[--tripwire "<op> <number>"\] \[--kind doc\|rule\|code\] \[--at <time>\]/m;
  const known = '(known: server-memory-kill, shared-cache-lock, agent-exit-wait; "other" is reserved)';
  const applied = (...args) => lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', ...args);
  const cfgFile = join(p, '.learn-from-mistakes.yaml'), v1 = readFileSync(cfgFile, 'utf8');
  const withConfig = (extra, base = v1) => { writeFileSync(cfgFile, base + extra); try { return lfm('ingest'); } finally { writeFileSync(cfgFile, v1); } };
  const bad = (rule) => new RegExp(`^error: .*\\.learn-from-mistakes\\.yaml: ${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
  for (const [run, code, error, next] of [
    [() => raw('frobnicate'), 2, 'unknown command "frobnicate" (commands: init, doctor, guide, ingest, count, report, change applied, changes, retro, status, runs, attach, logs, abort, rerun, agents, signoff, apply)', HELP],
    [() => raw('--bogus'), 2, 'unknown option "--bogus"', HELP], // a bare unknown flag points at --help
    [() => raw('report', '--bogus'), 2, 'unknown option "--bogus"', /^next: learn-from-mistakes-axi report \[--dir <dir>\]/m],
    [() => raw('change'), 2, '"change" must be followed by "applied"', CHANGE],
    [() => raw('report', 'extra'), 2, 'unexpected argument "extra"', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('report', '--dir'), 2, '--dir needs a value', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('changes', '--full'), 2, 'changes does not take --full', /^next: learn-from-mistakes-axi changes \[--dir <dir>\] \[--json\]$/m], // before any config is read
    [() => raw('ingest', '--json'), 2, 'ingest does not take --json', /^next: learn-from-mistakes-axi ingest \[--dir <dir>\]$/m],
    [() => raw('ingest', '--labels', 'x'), 2, 'ingest does not take --labels', /^next: learn-from-mistakes-axi ingest /m],
    [() => raw('report', '--cause', 'x'), 2, 'report does not take --cause', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw('--cause', 'x'), 2, 'report does not take --cause', HELP], // bare: no command was typed, so --help
    [() => raw('report', '--dir', 'a\u001b[31m'), 2, '--dir (invalid value): a path must not contain control characters', /^next: learn-from-mistakes-axi report \[/m],
    [() => raw(), 2, /^error: no \.learn-from-mistakes\.yaml in .*\n(.*\n)*  log: \{ type: markdown-log, path: defects\.md \}/m, /^next: learn-from-mistakes-axi guide   # the full config/m], // a config to copy, then the guide
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
    [() => applied('--metric', 'speed'), 2, /^error: --metric "speed" must be a metric \(merged, first_pass, .*, or cause_count:<cause>\)$/m, CHANGE],
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
    [() => raw('agents', '--test', 'claude'), 2, /^error: no \.learn-from-mistakes\.yaml in /m, /^next: learn-from-mistakes-axi guide/m], // --test writes in the project's state dir
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
    [() => withConfig('targets: { speed: ">= 1" }\n'), 2, /^error: .*: targets: speed must be a metric \(merged, first_pass, .*, or cause_count:<cause>\)$/m, HELP],
    [() => withConfig('agent_timeout: 20\n'), 2, bad('agent_timeout must be a duration such as 90s, 20m or 1h'), HELP],
    [() => withConfig('caps: { tokens: 5 }\n'), 2, bad('caps: unknown key tokens'), HELP],
    [() => withConfig('followup: { min_days: 0 }\n'), 2, bad('followup.min_days must be a positive integer'), HELP],
    [() => withConfig('excerpts: maybe\n'), 2, bad('excerpts must be on or off'), HELP],
    [() => withConfig('', v1.replace('sources:\n', 'sources:\n  s: { type: sessions }\n  more: { type: sessions }\n')), 2,
      bad("sources.s: sources.more already reads every agent's sessions; keep one and narrow it with agents"), HELP],
    [() => withConfig('', v1.replace('sources:\n', 'sources:\n  prs: { type: github }\n  more: { type: github }\n')), 2,
      bad("sources.prs: sources.more already reads the PRs of origin's GitHub repo; keep one"), HELP],
    ...[['source: log', 'causes.env.match.source must name a no-mistakes or sessions source'], ['source: gate, signal: test_fail', 'causes.env.match: unknown key signal'],
      ['source: s', 'causes.env.match needs a signal, tool or text_contains'], ['source: s, tool: ""', 'causes.env.match.tool must be a non-empty string'],
      ['source: s, signal: oops', 'causes.env.match.signal must be one of tool_error, nonzero_exit, test_fail, correction, interrupt, retry'],
    ].map(([m, rule]) => [() => withConfig('', v1.replace('sources:\n', 'sources:\n  s: { type: sessions }\n').replace('causes:\n', `causes:\n  env: { description: x, match: { ${m} } }\n`)), 2, bad(rule), HELP]),
    [() => withConfig('', v1.replace(/^name: .*$/m, 'name: 123')), 2, bad('name must be a string'), HELP],
    [() => withConfig('', v1.replace('causes:\n', 'causes:\n  Shared_Cache: { description: x }\n')), 2, bad('causes.Shared_Cache: a cause key must be 1-64 of a-z, 0-9 and - (rename it, for example to shared-cache)'), HELP],
    [() => lfm('count', '--labels', join(p, 'bad.jsonl')), 1, /^error: .*bad\.jsonl:2: not valid JSON$/m, /^next: learn-from-mistakes-axi count   # run again after fixing \(keep your --dir --labels\)$/m], // input problem, not usage
  ]) {
    const r = run();
    const what = typeof error === 'string' ? error : String(error);
    assert.equal(r.status, code, `${what}\n${r.stderr}`);
    assert.equal(r.stdout, '', what);
    if (typeof error === 'string') assert.ok(r.stderr.split('\n').includes(`error: ${error}`), `${what}\n${r.stderr}`);
    else assert.match(r.stderr, error);
    assert.match(r.stderr, next, what);
    assert.doesNotMatch(r.stderr, /usage: learn-from-mistakes-axi|--proposals <file> +proposals\.jsonl to read/, `${what}: printed the usage block`);
    assert.doesNotMatch(r.stderr, /y{81}|\u001b/, `${what}: echoed a long or control value`);
  }
});

test('bare report is valid TOON and JSON lfm-report.v1 with the same projection', () => {
  const { p, lfm } = setup();
  const ing = lfm('ingest');
  assert.equal(ing.status, 0);
  assert.doesNotMatch(ing.stderr, /no causes configured/); // the example config names its causes
  const bare = report(lfm, p);
  assert.equal(bare.status, 0, bare.stderr);
  const toon = decode(toonBodyOf(bare.stdout)); // invalid TOON throws; the summary line is outside the report
  assert.equal(toon.schema, 'lfm-report.v1');
  assert.equal(summaryOf(bare.stdout), 'repeated: server-memory-kill (4 incidents/3 days), agent-exit-wait (4 rows/3 days), shared-cache-lock (3 incidents/3 days)');
  assert.match(bare.stderr, /next: learn-from-mistakes-axi report --full/); // the next move is always offered
  for (const flag of ['--dir', '--labels', '--proposals']) assert.match(bare.stderr, new RegExp(flag)); // the hint names the inputs it used
  assert.ok(!bare.stderr.includes(p), 'the hint must not echo an input path value');

  const json = report(lfm, p, '--json');
  assert.equal(json.status, 0, json.stderr);
  const jsonModel = JSON.parse(json.stdout);
  // generated_at is each run's own time, so two runs never match on it; the rest is one projection.
  assert.deepEqual({ ...toon, generated_at: jsonModel.generated_at }, jsonModel);
  assert.ok(!Number.isNaN(Date.parse(toon.generated_at)), 'TOON generated_at is when that report ran');
  assert.equal(toon.ingested_at, jsonModel.ingested_at); // both runs share the same ingest

  const fullJson = report(lfm, p, '--full', '--json');
  assert.equal(fullJson.status, 0, fullJson.stderr);
  assert.doesNotMatch(fullJson.stderr, /next: learn-from-mistakes-axi report --json/); // never suggest a flag the run already used
  assert.equal(JSON.parse(fullJson.stdout).schema, 'lfm-report.v1'); // the projection is unchanged

  const causes = Object.fromEntries(toon.causes.map((c) => [c.cause, c]));
  assert.equal(causes['server-memory-kill'].log.incidents, 4); // occurrences: 2 collapsed into one incident
  assert.equal(causes['server-memory-kill'].log.records, 3);
  assert.equal(causes['shared-cache-lock'].log.incidents, 3); // duplicate_of collapsed
  assert.equal(causes['shared-cache-lock'].log.records, 4);
  assert.equal(causes['agent-exit-wait'].store.rows, 4); // typed store rows matched, never added to log
  assert.equal(causes['other'].repeated, false);
  assert.deepEqual(toon.coverage, { labelled: 13, total_records: 18, unlabelled: 5 }); // the 5 gate rows are records too
});

test('generated_at is the report run time and ingested_at is the ingest time', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const metaFile = join(p, '.lfm', 'sources.json');
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  const ingestTime = meta.read_at;
  assert.ok(!Number.isNaN(Date.parse(ingestTime)), 'ingest records its own time');
  // Backdate the ingest time so the report run is observably later without sleeping.
  const earlier = '2026-01-01T00:00:00.000Z';
  writeFileSync(metaFile, JSON.stringify({ ...meta, read_at: earlier }, null, 1));
  for (const cmd of ['report', 'count']) {
    const run = cmd === 'report'
      ? report(lfm, p, '--json')
      : lfm('count', '--labels', inputs(p)[0], '--proposals', inputs(p)[1], '--json');
    assert.equal(run.status, 0, run.stderr);
    const model = JSON.parse(run.stdout);
    assert.equal(model.schema, 'lfm-report.v1'); // an added field, not a new schema
    assert.equal(model.ingested_at, earlier);
    assert.ok(Date.parse(model.generated_at) > Date.parse(model.ingested_at), `${cmd}: report time is later than ingest time`);
    assert.ok(Math.abs(Date.now() - Date.parse(model.generated_at)) < 60_000, `${cmd}: generated_at is when the report ran`);
  }
  // The default TOON report carries the same two fields.
  const toon = decode(toonBodyOf(report(lfm, p).stdout));
  assert.equal(toon.ingested_at, earlier);
  assert.ok(Date.parse(toon.generated_at) > Date.parse(toon.ingested_at));
});

test('the TOON report ends with one repeated summary line; --json is unchanged', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const expected = 'repeated: server-memory-kill (4 incidents/3 days), agent-exit-wait (4 rows/3 days), shared-cache-lock (3 incidents/3 days)';
  // report, count and the bare command print the same TOON summary last on stdout.
  for (const args of [
    ['report', '--labels', inputs(p)[0], '--proposals', inputs(p)[1]],
    ['count', '--labels', inputs(p)[0], '--proposals', inputs(p)[1]],
    ['--labels', inputs(p)[0], '--proposals', inputs(p)[1]],
  ]) {
    const r = lfm(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(summaryOf(r.stdout), expected, args.join(' '));
    assert.deepEqual(decode(toonBodyOf(r.stdout)).schema, 'lfm-report.v1');
    assert.doesNotMatch(toonBodyOf(r.stdout), /^repeated: /m); // the summary is outside the report
  }
  // --json carries the same projection with no summary line.
  const json = report(lfm, p, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.doesNotMatch(json.stdout, /^repeated: /m);
  assert.equal(JSON.parse(json.stdout).schema, 'lfm-report.v1');
  // Nothing repeated prints none, with ids and counts only, never record text.
  // With nothing repeated every stock proposal would be a problem, so this reports with none.
  writeFileSync(join(p, 'empty.jsonl'), '');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8')
    .replace('min_incidents: 3', 'min_incidents: 99'));
  assert.equal(lfm('ingest').status, 0);
  const calm = lfm('report', '--labels', inputs(p)[0], '--proposals', join(p, 'empty.jsonl'));
  assert.equal(calm.status, 0, calm.stderr);
  assert.equal(summaryOf(calm.stdout), 'repeated: none');
  assert.doesNotMatch(calm.stdout, /memory killer stopped|wait delay expired/i);
});

test('ingest identifies the store by the rows it read, not its mtime, and never writes the store', () => {
  const { p, lfm } = setup();
  const db = join(p, 'gate.sqlite');
  const bytes = () => createHash('sha256').update(readFileSync(db)).digest('hex');
  const ingest = () => {
    const before = bytes();
    const r = lfm('ingest');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bytes(), before); // the read leaves the store's bytes as they were
    const short = r.stdout.match(/^gate +no-mistakes +5 items  sha256 ([0-9a-f]{12})$/m)?.[1];
    assert.ok(short, r.stdout);
    const hash = JSON.parse(readFileSync(join(p, '.lfm', 'sources.json'), 'utf8')).sources.find((s) => s.id === 'gate').hash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash.slice(0, 12), short);
    return hash;
  };
  const first = ingest();
  utimesSync(db, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z')); // same rows, new mtime
  assert.equal(ingest(), first);

  const w = new DatabaseSync(db);
  w.prepare("UPDATE step_results SET error = 'not read' WHERE id = 'step-2'").run(); // a completed step: new bytes, same rows read
  assert.equal(ingest(), first);
  const { atime, mtime } = statSync(db);
  w.prepare("UPDATE step_results SET error = 'lint: 3 errors' WHERE id = 'step-5'").run(); // one failed step's text
  w.close();
  utimesSync(db, atime, mtime); // changed rows, same mtime
  assert.equal(Math.round(statSync(db).mtimeMs), mtime.getTime());
  assert.notEqual(ingest(), first);
});

test('a store row with no timestamp still counts as a row but never as a day', () => {
  const { p, lfm } = setup();
  const w = new DatabaseSync(join(p, 'gate.sqlite'));
  w.exec(`UPDATE step_results SET started_at = 1772618400, completed_at = 1772619000 WHERE id IN ('step-1', 'step-3');
    UPDATE step_results SET started_at = NULL, completed_at = NULL WHERE id = 'step-4';`); // 3 matching rows on one day, 1 undated
  w.close();
  assert.equal(lfm('ingest').status, 0);
  // agent-exit-wait no longer repeats, so its stock proposal would be a problem; report without it.
  const kept = readFileSync(join(p, 'proposals.jsonl'), 'utf8').split('\n').filter((l) => !l.includes('"agent-exit-wait"')).join('\n');
  writeFileSync(join(p, 'dated.jsonl'), kept);
  const r = lfm('report', '--labels', inputs(p)[0], '--proposals', join(p, 'dated.jsonl'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout).causes.find((x) => x.cause === 'agent-exit-wait');
  assert.deepEqual(c.store, { matched: true, rows: 4, days: 1 });
  assert.equal(c.repeated, false); // min_days: 2 is not met by one real day
});

test('next hints compose the flags already used so both report chains terminate at full+json', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const nextOf = (stderr) => stderr.split('\n').find((l) => l.startsWith('next: '))?.slice(6).split('   #')[0].trim();
  const runHint = (line) => lfm(...line.replace(/^learn-from-mistakes-axi /, '').split(' '), '--labels', inputs(p)[0], '--proposals', inputs(p)[1]);
  const assertTerminal = (r) => {
    assert.equal(r.status, 0, r.stderr);
    const model = JSON.parse(r.stdout);
    assert.equal(model.schema, 'lfm-report.v1');
    assert.ok(model.causes.find((c) => c.cause === 'agent-exit-wait').store_row_ids.includes('gate:step-1')); // detail ids survive the chain
    assert.doesNotMatch(r.stdout, /"why"|"change"|"description"|"branch"/); // no private prose field
    assert.ok(!r.stderr.includes(p), 'the hint must not echo an input path value');
    assert.equal(nextOf(r.stderr), undefined); // the chain ends here
  };

  const hint1 = nextOf(report(lfm, p).stderr); // report -> --full
  assert.equal(hint1, 'learn-from-mistakes-axi report --full');
  const hint2 = nextOf(runHint(hint1).stderr); // --full -> --full --json
  assert.equal(hint2, 'learn-from-mistakes-axi report --full --json');
  assertTerminal(runHint(hint2)); // --full --json is terminal

  const hintJson = nextOf(report(lfm, p, '--json').stderr); // report --json -> --full --json
  assert.equal(hintJson, 'learn-from-mistakes-axi report --full --json');
  assertTerminal(runHint(hintJson));
});

test('--full adds only non-content ids, never record text or record ids', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const full = JSON.parse(report(lfm, p, '--full', '--json').stdout);
  const cause = full.causes.find((c) => c.cause === 'shared-cache-lock');
  assert.ok(!('record_ids' in cause)); // a content hash is never emitted
  assert.deepEqual(cause.proposal_refs, []); // refs that are record ids are not echoed as evidence
  assert.equal(cause.store_row_ids.length, 0);
  const gate = full.causes.find((c) => c.cause === 'agent-exit-wait');
  assert.ok(gate.store_row_ids.includes('gate:step-1'));
  assert.ok(gate.proposal_refs.includes('gate:step-1')); // a non-content ref survives
  const text = JSON.stringify(full);
  assert.doesNotMatch(text, /memory killer stopped/i); // no record text
  assert.doesNotMatch(text, /1b35bb2034fa/); // no content-derived record id
  assert.doesNotMatch(text, /Give each worker its own cache/); // no proposal change text
  assert.doesNotMatch(text, /"why"|"change"|"description"|"branch"/); // no private prose fields at all
});

test('private canary prose never reaches default, --json, --full or stderr', () => {
  const { p, lfm } = setup();
  appendFileSync(join(p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  const plant = (text, anchor) => {
    assert.ok(text.includes(anchor), `fixture has no "${anchor}" to carry the canary`);
    return text.replace(anchor, `${CANARY} ${anchor}`);
  };
  const canaryLabels = join(p, `${CANARY}-labels.jsonl`);
  writeFileSync(canaryLabels, plant(readFileSync(join(p, 'labels.jsonl'), 'utf8'), 'Memory killer stopped'));
  const canaryProposals = join(p, `${CANARY}-proposals.jsonl`);
  writeFileSync(canaryProposals, plant(readFileSync(join(p, 'proposals.jsonl'), 'utf8'), 'Run builds in their own memory group'));
  assert.equal(lfm('ingest').status, 0);
  for (const extra of [[], ['--json'], ['--full'], ['--full', '--json']]) {
    const r = lfm('report', '--labels', canaryLabels, '--proposals', canaryProposals, ...extra);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, new RegExp(CANARY));
    assert.doesNotMatch(r.stderr, new RegExp(CANARY));
  }
});

test('a labelled gate row counts once: its label decides the cause, not its error tag', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const none = join(p, 'none-labels.jsonl'), labelled = join(p, 'gate-labels.jsonl');
  writeFileSync(none, '');
  writeFileSync(labelled, JSON.stringify({ id: 'gate:step-1', event: true, cause: 'server-memory-kill', why: 'the agent server was killed' }) + '\n');
  const causeOf = (r, cause) => r.causes.find((c) => c.cause === cause) ?? { log: { incidents: 0 }, store: { rows: 0 } };
  const before = JSON.parse(lfm('report', '--labels', none, '--json').stdout);
  const after = JSON.parse(lfm('report', '--labels', labelled, '--json').stdout);
  assert.equal(causeOf(after, 'agent-exit-wait').store.rows, causeOf(before, 'agent-exit-wait').store.rows - 1);
  assert.equal(causeOf(after, 'server-memory-kill').log.incidents, causeOf(before, 'server-memory-kill').log.incidents + 1);
});

test('bad input is counted, never echoed; unresolved refs exit 1', () => {
  const { p, lfm } = setup();
  const long = `- [runner] ${'x'.repeat(20000)}\n`;
  appendFileSync(join(p, 'defects.md'), long + long); // largest existing fixture, two records
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'bad.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":"server-memory-kill","why":"x"}\n{not json\n');
  const bad = lfm('count', '--labels', join(p, 'bad.jsonl'));
  assert.equal(bad.status, 1); // a bad line in a file the run reads is an input problem
  assert.match(bad.stderr, /^error: .*bad\.jsonl:2: not valid JSON$/m);
  writeFileSync(join(p, 'refs.jsonl'), '{"cause":"server-memory-kill","target":"t","owner":"o","change":"c","refs":["nope"]}\n');
  const r = report(lfm, p, '--proposals', join(p, 'refs.jsonl'));
  assert.equal(r.status, 1);
  const model = decode(r.stdout);
  assert.equal(model.problems, 1); // a problem is counted in the report, its line goes to stderr only
  assert.doesNotMatch(r.stdout, /nope/);
  assert.match(r.stderr, /^problem: refs\.jsonl:1: 1 of 1 refs not found$/m);
  assert.doesNotMatch(r.stderr, /nope/); // a ref may be a record id: counted, never echoed
  const full = JSON.parse(report(lfm, p, '--proposals', join(p, 'refs.jsonl'), '--full', '--json').stdout);
  assert.deepEqual(full.causes.find((c) => c.cause === 'server-memory-kill').proposal_refs, []); // an unresolved ref is never echoed as evidence
  // A label orphaned by an edited record, and a second label for a real record: the user sees which
  // lines broke, never the real record's id (a hash of its private text).
  writeFileSync(join(p, 'odd.jsonl'), '{"id":"ffffffffffff","event":true,"cause":"server-memory-kill","why":"x"}\n'
    + '{"id":"2034b8c4ce57","event":true,"cause":"server-memory-kill","why":"x"}\n{"id":"2034b8c4ce57","event":false,"why":"x"}\n');
  const odd = lfm('count', '--labels', join(p, 'odd.jsonl'));
  assert.equal(decode(odd.stdout).problems, 2);
  assert.match(odd.stderr, /^problem: odd\.jsonl:1: unknown record id \(its record text changed or it was never ingested\)$/m);
  assert.match(odd.stderr, /^problem: odd\.jsonl:3: second label for the record labelled at line 2$/m);
  assert.doesNotMatch(odd.stderr, /2034b8c4ce57|ffffffffffff/); // no record id, current or orphaned
  appendFileSync(join(p, '.learn-from-mistakes.yaml'), 'colour: blue\n');
  assert.equal(lfm('count').status, 2);
  assert.match(lfm('count').stderr, /unknown key colour/);
});

test('proposals follow the guide: repeated causes only, target, owner, at most five', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const good = (cause) => JSON.stringify({ cause, target: 't', owner: 'o', change: 'c', refs: ['2034b8c4ce57'] });
  const ref = ['2034b8c4ce57'];
  for (const [file, lines, line, message] of [
    ['unrepeated.jsonl', `${good('other')}\n`, 1, 'cause "other" did not repeat; propose only for repeated causes'],
    ['no-target.jsonl', `${JSON.stringify({ cause: 'server-memory-kill', owner: 'o', change: 'c', refs: ref })}\n`, 1, 'no target'],
    ['no-owner.jsonl', `${JSON.stringify({ cause: 'server-memory-kill', target: 't', owner: '   ', change: 'c', refs: ref })}\n`, 1, 'no owner'],
    ['sixth.jsonl', `${Array.from({ length: 6 }, () => good('server-memory-kill')).join('\n')}\n`, 6, 'more than five proposals; keep the five strongest'],
  ]) {
    writeFileSync(join(p, file), lines);
    const r = lfm('report', '--labels', inputs(p)[0], '--proposals', join(p, file));
    assert.equal(r.status, 1, file);
    assert.equal(decode(r.stdout).problems, 1, `${file}: the report still prints with the problem counted`);
    assert.ok(r.stderr.split('\n').includes(`problem: ${file}:${line}: ${message}`), `${file}\n${r.stderr}`);
  }
});

test('prototype-named causes are counted as problems, never crash or vanish', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'proto.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":"constructor","why":"x"}\n');
  writeFileSync(join(p, 'proto-proposals.jsonl'), '{"cause":"constructor","target":"t","owner":"o","change":"c","refs":["2034b8c4ce57"]}\n');
  const r = lfm('report', '--labels', join(p, 'proto.jsonl'), '--proposals', join(p, 'proto-proposals.jsonl'));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /next: learn-from-mistakes-axi report .*--labels .*--proposals/); // the re-run keeps the inputs it was given
  const model = decode(r.stdout);
  assert.equal(model.problems, 2); // the label and the proposal are each counted
  assert.ok(!model.causes.some((c) => c.cause === 'constructor'));
});

test('non-string causes are counted as problems, never coerced into a configured cause', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'array-labels.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":["server-memory-kill"],"why":"x"}\n');
  writeFileSync(join(p, 'array-proposals.jsonl'), '{"cause":["server-memory-kill"],"target":"t","owner":"o","change":"c","refs":["2034b8c4ce57"]}\n');
  const r = lfm('report', '--labels', join(p, 'array-labels.jsonl'), '--proposals', join(p, 'array-proposals.jsonl'));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(decode(r.stdout).problems, 2); // the label and the proposal are each counted
  assert.ok(!decode(r.stdout).causes.some((c) => c.cause === 'server-memory-kill')); // and the cause is not silently grouped
});

test('an unreadable source or input file is a usage error, never a crash', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: missing.md }\n');
  const missing = lfm('ingest');
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /^error: source log: cannot read \(ENOENT\)$/m);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log }\n  prs: { type: github }\n');
  const noPath = lfm('ingest'); // each source type checks its own keys
  assert.equal(noPath.status, 2, noPath.stderr);
  assert.match(noPath.stderr, /^error: .*: sources\.log\.path must be a string$/m);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: [markdown-log], path: defects.md }\n');
  assert.match(lfm('ingest').stderr, /^error: .*: sources\.log\.type must be one of markdown-log, no-mistakes, sessions, github, done-done$/m); // a list is not a type
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  prs: { type: github, repo: umer/app }\n'); // the repo comes from origin
  assert.match(lfm('ingest').stderr, /^error: .*: sources\.prs: unknown key repo$/m);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  gate: { type: no-mistakes, path: no-state.sqlite }\n');
  const store = lfm('ingest');
  assert.equal(store.status, 2, store.stderr);
  assert.match(store.stderr, /^error: source gate: no such file$/m);
  assert.ok(store.stderr.includes(`next: set sources.gate.path in ${join(p, '.learn-from-mistakes.yaml')} to your no-mistakes state.sqlite, or remove that source`), store.stderr);
  const flat = new DatabaseSync(join(p, 'flat.sqlite')); // no repos table: its rows cannot be told from other repos' rows
  flat.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, branch TEXT); CREATE TABLE step_results (id TEXT PRIMARY KEY, run_id TEXT, step_name TEXT, status TEXT, error TEXT, started_at INTEGER, completed_at INTEGER)`);
  flat.close();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  gate: { type: no-mistakes, path: flat.sqlite }\n');
  const flatRun = lfm('ingest');
  assert.equal(flatRun.status, 2, flatRun.stderr);
  assert.match(flatRun.stderr, /^error: source gate: not a readable no-mistakes store \(no such table: repos\)$/m);
  assert.doesNotMatch(missing.stderr, /\n\s+at /); // no stack trace
  cpSync(join(new URL('../examples', import.meta.url).pathname, '.learn-from-mistakes.yaml'), join(p, '.learn-from-mistakes.yaml'));
  assert.equal(lfm('ingest').status, 0);
  const dir = lfm('count', '--labels', p);
  assert.equal(dir.status, 2, dir.stderr);
  assert.match(dir.stderr, /cannot read \(EISDIR\)/);
  assert.doesNotMatch(dir.stderr, /\n\s+at /);
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
  const ingest = lfm('ingest');
  assert.equal(ingest.status, 0, ingest.stderr);
  const records = readFileSync(join(p, '.lfm', 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const file = (id) => join(env.DONE_DONE_HOME, 'runs', 'notes', id, 'run.json');
  assert.deepEqual(records, [
    { id: 'dd:notes/r1/check', source: 'dd', step: 'check', ref: file('r1'), date: ENDED.slice(0, 10), text: 'verify fail: check: shot.png: judge says wrong screen; token=[redacted]' },
    { id: 'dd:notes/r2/drive', source: 'dd', step: 'drive', ref: file('r2'), date: UPDATED.slice(0, 10), text: 'verify inconclusive: drive: journey timed out after 30m' },
    { id: 'dd:notes/r6/judge', source: 'dd', step: 'judge', ref: file('r6'), date: UPDATED.slice(0, 10), text: 'verify overridden: judge: shot.png: judge says wrong screen' },
    { id: 'dd:notes/r7/setup', source: 'dd', step: 'setup', ref: file('r7'), date: UPDATED.slice(0, 10), text: 'verify failed: setup: .done-done.yaml: bad key' }]);
  const doctor = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'source dd');
  assert.match(doctor.detail, /^done-done: 4 failed or inconclusive verify steps, 4 in the window; no runs for nottes in /);
  assert.match(doctor.fix, /^ls .*# done-done's app names; set sources\.dd\.apps in /);
  const bin = join(p, '..', 'dd-bin'); // the retro's worker and judge are the fake one, never the host's claude login
  mkdirSync(bin);
  symlinkSync(FAKE_AGENT, join(bin, 'claude'));
  symlinkSync(FAKE_AGENT, join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const retro = spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--dir', p], { encoding: 'utf8', env: { ...env, PATH: bin } });
  assert.equal(retro.status, 0, retro.stderr);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT record_id, ref FROM records ORDER BY record_id').all().map((r) => ({ ...r })),
    ['r1/check', 'r2/drive', 'r6/judge', 'r7/setup'].map((r) => ({ record_id: `dd:notes/${r}`, ref: file(r.split('/')[0]) })));
  db.close();

  run('r5', { schema: 3, result: 'fail', steps: steps('check') }); // a newer done-done: never skipped, never a crash
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  dd: { type: done-done, apps: [notes], path: dd-home }\n');
  const newer = lfm('ingest');
  assert.equal(newer.status, 2, newer.stderr);
  assert.ok(newer.stderr.includes(`error: source dd: ${file('r5')} is done-done run schema 3; this version reads schema 2\n`), newer.stderr);
  assert.match(newer.stderr, /^next: update learn-from-mistakes-axi to read it, or remove sources\.dd from /m);
  assert.doesNotMatch(newer.stderr, /\n\s+at /);
  run('r5', { result: 'fail', steps: [null] });
  const broken = lfm('ingest');
  assert.equal(broken.status, 2, broken.stderr);
  assert.ok(broken.stderr.includes(`error: source dd: ${file('r5')} is not done-done run state (steps)\nnext: done-done status --run r5   # in the notes repo`), broken.stderr);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  dd: { type: done-done, apps: [../x] }\n');
  assert.match(lfm('ingest').stderr, /^error: .*: sources\.dd\.apps must be a list of done-done app names$/m);
});

test('an explicit labels or proposals path that does not exist is a usage error', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const unlabelled = lfm('report');
  assert.equal(unlabelled.status, 0); // the default state-dir inputs may be absent before labelling
  const records = join(p, '.lfm', 'records.jsonl');
  assert.ok(unlabelled.stderr.split('\n').some((l) => l.startsWith(`next: label ${records} into labels.jsonl`)), unlabelled.stderr); // with zero labels, labelling the named file is the next step
  const labels = lfm('report', '--labels', join(p, 'typo-labels.jsonl'));
  assert.equal(labels.status, 2, labels.stdout);
  assert.match(labels.stderr, /^error: --labels .*typo-labels\.jsonl: no such file$/m);
  const proposals = lfm('report', '--proposals', join(p, 'typo-proposals.jsonl'));
  assert.equal(proposals.status, 2, proposals.stdout);
  assert.match(proposals.stderr, /^error: --proposals .*typo-proposals\.jsonl: no such file$/m);
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
  const empty = JSON.parse(exported('--json').stdout); // needs the config only: no ingest, no ledger yet
  assert.equal(empty.schema, 'lfm-changes.v1');
  assert.deepEqual(empty.changes, []);
  assert.equal(change('--cause', 'nope', '--ref', 'abc1234').status, 2); // rejected input creates nothing
  assert.ok(!existsSync(ledger));
  // Private prose sits in every input; it must never reach any change or report output.
  appendFileSync(join(p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  const plant = (text, anchor) => {
    assert.ok(text.includes(anchor), `fixture has no "${anchor}" to carry the canary`);
    return text.replace(anchor, `${CANARY} ${anchor}`);
  };
  const labels = join(p, `${CANARY}-labels.jsonl`);
  writeFileSync(labels, plant(readFileSync(join(p, 'labels.jsonl'), 'utf8'), 'Memory killer stopped'));
  const proposals = join(p, `${CANARY}-proposals.jsonl`);
  writeFileSync(proposals, plant(readFileSync(join(p, 'proposals.jsonl'), 'utf8'), 'Run builds in their own memory group'));
  assert.equal(lfm('ingest').status, 0);
  const inputs = ['--labels', labels, '--proposals', proposals];

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

  for (const args of [['--full'], ['--labels', labels], ['--cause', 'server-memory-kill'], ['--what', 'x']]) {
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

  const json = lfm('report', ...inputs, '--json'); // a fresh process reads the persisted ledger
  assert.equal(json.status, 0, json.stderr);
  const model = JSON.parse(json.stdout);
  assert.equal(model.schema, 'lfm-report.v1');
  assert.deepEqual(model.ledger, { entries: 2 });
  assert.deepEqual(model.causes.find((c) => c.cause === 'server-memory-kill').changes, { count: 2, last_at: firstEntry.at });
  assert.deepEqual(model.causes.find((c) => c.cause === 'shared-cache-lock').changes, { count: 0, last_at: '' });
  const bare = lfm('report', ...inputs);
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual({ ...decode(toonBodyOf(bare.stdout)), generated_at: model.generated_at }, model); // TOON decodes equal to JSON
  assert.equal(summaryOf(bare.stdout), 'repeated: server-memory-kill (4 incidents/3 days), agent-exit-wait (4 rows/3 days), shared-cache-lock (3 incidents/3 days)');
  const fullRun = lfm('report', ...inputs, '--full', '--json');
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
  assert.deepEqual(JSON.parse(lfm('report', ...inputs, '--json').stdout).ledger, { entries: 5 });

  // The default metric comes from the cause key as the config spells it; the ledger still reads.
  assert.equal(change('--cause', 'agent-exit-wait', '--ref', 'abc1234').status, 0);
  assert.deepEqual(JSON.parse(exported('--json').stdout).changes.slice(5).map((c) => c.metric), ['cause_count:agent-exit-wait']);
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

test('empty input exits 3 with a next command', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, 'defects.md'), '');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  const early = lfm('count'); // before ingest: name the missing step, not just --help
  assert.equal(early.status, 2);
  assert.match(early.stderr, /next: learn-from-mistakes-axi ingest/);
  const ing = lfm('ingest');
  assert.match(ing.stdout, /log +markdown-log +0 items/);
  assert.match(ing.stderr, /^next: no causes configured: every label will be other; ask your agent to propose causes$/m);
  assert.match(ing.stdout, /then learn-from-mistakes-axi count .*--dir/); // the labelling step keeps the dir it was told to use
  assert.match(ing.stderr, /next: learn-from-mistakes-axi\b.*--dir/); // the report hint keeps the dir it was told to use
  const r = lfm('count');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /nothing to count/);
  assert.match(r.stderr, /next: learn-from-mistakes-axi ingest/);
  assert.match(r.stderr, /--dir/);
  assert.ok(!r.stderr.includes(p), 'the empty-input hint must not echo an input path value');
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

test('retro --foreground saves a run and its steps in .lfm/; status and runs show it', () => {
  const { p, lfm } = setup();
  const git = (...args) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const none = lfm('status'); // before any run: nothing to read, and reads never create state
  assert.equal(none.status, 3, none.stderr);
  assert.match(none.stderr, /^next: learn-from-mistakes-axi retro --wait 8m   # ingest and report as a saved run \(keep your --dir\)$/m);
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout), { runs: [] });
  assert.ok(!existsSync(join(p, '.lfm')));

  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning/); // the examples read a store, so node:sqlite loads
  const run = decode(r.stdout);
  assert.equal(run.run.status, 'completed');
  assert.deepEqual(run.steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['propose', 'completed'], ['verify', 'completed'], ['check', 'completed'], ['report', 'completed'], ['apply', 'completed']]);
  // The bundle: the metrics; the example's records and gate rows are all from March, before this window.
  const bundle = readFileSync(join(p, '.lfm', 'runs', String(run.run.id), 'bundle.md'), 'utf8');
  assert.match(bundle, /^\| defects \| 0 \| 0 \|  \|$/m);
  assert.match(bundle, /^No follow-ups yet\.$/m);
  assert.match(bundle, /^No session event has a failure signal in this window\.$/m);
  assert.match(bundle, /^No record in this window lacks a cause\.$/m);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  const steps = db.prepare('SELECT name, output_json FROM steps WHERE run_id = ? ORDER BY ord').all(run.run.id);
  db.close();
  assert.deepEqual(JSON.parse(steps[0].output_json).sources.map((s) => s.items), [13, 5]);
  assert.deepEqual(JSON.parse(steps[8].output_json).coverage, { labelled: 0, total_records: 18, unlabelled: 18 }); // no labels yet
  const status = lfm('status', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), run);
  assert.deepEqual(decode(lfm('runs').stdout), { runs: [run.run] });
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
signoff: auto
allow_premium: false
`);
  mkdirSync(join(p, '..', 'home'), { recursive: true });
  writeFileSync(join(p, '..', 'home', 'config.yaml'), 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna, effort: low } }\nagent_timeout: 5m\nallow_premium: false\nagent_path_override: { claude: ~/bin/claude }\nagent_args_override: { codex: [--profile, cheap] }\nacpx_path: acpx\n');
  const v2 = lfm('retro', '--foreground', '--json');
  assert.equal(v2.status, 0, v2.stderr);
  assert.deepEqual(JSON.parse(v2.stdout).steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['propose', 'completed'], ['verify', 'completed'], ['check', 'completed'], ['report', 'completed'], ['apply', 'completed']]);
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
  assert.deepEqual(f.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'failed', 'pending']);
  assert.match(failed.stderr, /^error: report: no records or rows in the sources: nothing to count$/m);
  assert.match(failed.stderr, /^next: learn-from-mistakes-axi rerun --resume --run \d+   # finish it after fixing the report step/m);
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout).runs[0], f.run);
  assert.deepEqual(JSON.parse(lfm('status', '--json', '--run', String(run.run.id)).stdout), run);
  const missing = lfm('status', '--run', '99');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: no run 99$/m);

  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: gone.md }\n  store: { type: no-mistakes, path: gone.sqlite }\n');
  const unreadable = lfm('retro', '--foreground', '--json');
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.equal(JSON.parse(unreadable.stdout).run.error, 'collect: source log: cannot read (ENOENT)');
  assert.match(unreadable.stderr, /^error: collect: source log: cannot read \(ENOENT\)$/m);
  assert.ok(!unreadable.stdout.includes(p) && !unreadable.stderr.includes(p), 'a source path must not reach machine output');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  store: { type: no-mistakes, path: gone.sqlite }\n');
  const noStore = lfm('retro', '--foreground', '--json');
  assert.equal(JSON.parse(noStore.stdout).run.error, 'collect: source store: no such file');
  assert.ok(!noStore.stdout.includes(p) && !noStore.stderr.includes(p), 'a source path must not reach machine output');

  const hold = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite')); // another process holds the write lock past busy_timeout
  hold.exec('BEGIN IMMEDIATE');
  const read = lfm('status', '--json'); // a read command takes the write lock only when a running run has lost its worker
  const busy = lfm('retro', '--foreground');
  hold.exec('ROLLBACK');
  hold.close();
  assert.equal(read.status, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).run.error, 'collect: source store: no such file');
  assert.equal(busy.status, 2, busy.stderr);
  assert.match(busy.stderr, /^error: .*lfm\.sqlite is busy: another learn-from-mistakes-axi process is writing it\nnext: learn-from-mistakes-axi status   # wait a moment and check the running run; abort --run <id> stops it \(keep your --dir\)\n$/);
  assert.equal(JSON.parse(lfm('status', '--json').stdout).run.error, 'collect: source store: no such file'); // the store keeps its runs

  chmodSync(join(p, '.lfm'), 0o555); // a readable store that cannot be written is not a run store: no mv hint
  chmodSync(join(p, '.lfm', 'lfm.sqlite'), 0o444);
  const readonly = lfm('status');
  chmodSync(join(p, '.lfm', 'lfm.sqlite'), 0o644);
  chmodSync(join(p, '.lfm'), 0o755);
  assert.equal(readonly.status, 2, readonly.stderr);
  assert.doesNotMatch(readonly.stderr, /^next: mv /m);
  assert.match(readonly.stderr, /^next: learn-from-mistakes-axi status   # after the disk or the file permissions are fixed/m);

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
  assert.deepEqual(first.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed']);
  // A run whose worker labelled nothing and found nothing says so in one plain line, with where to see why.
  assert.deepEqual(first.result, { labelled: 0, records: 18, labels_from: 'labels.jsonl', causes: [{ cause: 'agent-exit-wait', repeated: true, incidents: 0, days: 0, rows: 4 }], findings: [] }); // a match rule counts gate rows
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
    steps = JSON.parse(lfm('status', '--json').stdout).steps;
    if (steps[8].status === 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.deepEqual(steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'running', 'pending']);
  const busy = lfm('retro');
  assert.equal(busy.status, 2, busy.stderr);
  assert.match(busy.stderr, new RegExp(`^error: run ${run.id} is still running$`, 'm'));

  process.kill(run.pid, 'SIGKILL'); // a crash: no trap runs, so only reconcile can see it
  for (let i = 0; i < 50 && JSON.parse(lfm('status', '--json').stdout).run.status === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
  const killed = lfm('status', '--json');
  assert.equal(killed.status, 0, killed.stderr);
  const k = JSON.parse(killed.stdout);
  assert.equal(k.run.status, 'interrupted');
  assert.equal(k.run.error, 'report: the worker stopped before the step ended');
  assert.deepEqual(k.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'interrupted', 'pending']);
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
  assert.deepEqual(r.steps.slice(0, 8), k.steps.slice(0, 8), 'the completed collect, metrics, followup, bundle, analyse, propose, verify and check steps were not run again');
  assert.deepEqual(r.metrics, k.metrics);
  const again = lfm('rerun', '--resume', '--run', String(run.id));
  assert.equal(again.status, 2, again.stderr);
  assert.match(again.stderr, new RegExp(`^error: run ${run.id} already completed$`, 'm'));
  assert.deepEqual(JSON.parse(lfm('runs', '--json').stdout).runs.map((x) => x.status), ['completed', 'completed', 'completed']);
});

test('attach follows a run to its end; logs prints one step; abort cancels a run and rerun starts it again', async () => {
  const { p, lfm, env } = setup();
  const wait = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 200)); }; // up to 20 s
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
  assert.match(nope.stderr, new RegExp(`^error: run ${first.id} has no step "judge" \\(steps: collect, metrics, followup, bundle, analyse, propose, verify, check, report, apply\\)$`, 'm'));

  // abort stops a running run: its worker ends and the run is cancelled; a new retro is not blocked.
  const slow = spawnSync(process.execPath, [CLI, 'retro', '--json', '--dir', p], { encoding: 'utf8', env: { ...env, LFM_TEST_SLOW_STEP: 'report' } });
  const { run } = JSON.parse(slow.stdout);
  after(() => { try { process.kill(run.pid, 'SIGKILL'); } catch {} });
  await wait(() => JSON.parse(lfm('status', '--json').stdout).steps[8].status === 'running');
  const busy = lfm('retro');
  assert.equal(busy.status, 2, busy.stderr);
  assert.match(busy.stderr, new RegExp(`^error: run ${run.id} is still running$`, 'm'));
  const aborted = lfm('abort', '--json');
  assert.equal(aborted.status, 0, aborted.stderr);
  const a = JSON.parse(aborted.stdout);
  assert.equal(a.run.status, 'cancelled');
  assert.equal(a.run.error, 'report: cancelled by SIGTERM'); // the worker's own trap ended it
  assert.deepEqual(a.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'cancelled', 'pending']);
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
  const lfm = (extra, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, PATH: bin, FAKE_LOG: log, ...extra } });
  const query = (sql, ...args) => { const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(...args).map((x) => ({ ...x })); } finally { db.close(); } };
  const calls = (name = 'claude') => readFileSync(join(log, `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lines = (step, id) => JSON.parse(lfm({}, 'logs', '--step', step, '--run', String(id), '--json').stdout).log.map((l) => l.line);
  return { p, env, bin, lfm, query, calls, lines };
}

test('analyse: the worker labels the bundle\'s records and names findings; a ref to no bundle item is a problem; bad JSON twice fails the step; a crash leaves no agent', async () => {
  const { p, env, bin, lfm, query, calls, lines: stepLines } = agentSetup();
  const global = join(env.LFM_HOME, 'config.yaml'); // the user set agent: claude and its model there; the run never picks one
  const lines = (id) => stepLines('analyse', id);

  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock' }, 'retro', '--wait', '1m', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run, steps, result } = JSON.parse(r.stdout);
  assert.deepEqual(steps.map((s) => [s.name, s.status]).slice(3), [['bundle', 'completed'], ['analyse', 'completed'], ['propose', 'completed'], ['verify', 'completed'], ['check', 'completed'], ['report', 'completed'], ['apply', 'completed']]);
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
  // The report step counts with the worker's labels: no hand-written labels.jsonl is needed.
  assert.ok(!existsSync(join(p, '.lfm', 'labels.jsonl')));
  const report = JSON.parse(query(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'report'`, run.id)[0].output_json);
  assert.equal(report.coverage.labelled, 2);
  assert.deepEqual(report.causes.filter((c) => c.log.incidents).map((c) => [c.cause, c.log.incidents]), [['shared-cache-lock', 2]]);
  // retro --wait shows the result: the counted causes and the worker's findings, each one line; then where the evidence is.
  const finding = { cause: 'umer-fixtures-unset', count: 1, days: 1, verdict: 'confirmed', summary: 'The tests fail when UMER_FIXTURES is unset. No doc names it.' };
  assert.deepEqual(result, { labelled: 2, records: 20, labels_from: `run ${run.id}`, causes: [{ cause: 'agent-exit-wait', repeated: true, incidents: 0, days: 0, rows: 4 }, { cause: 'shared-cache-lock', repeated: false, incidents: 2, days: 1, rows: 0 }], findings: [finding] });
  assert.match(lfm({}, 'status').stdout, /^ {2}findings\[1\]\{cause,count,days,verdict,summary\}:\n {4}umer-fixtures-unset,1,1,confirmed,The tests fail when UMER_FIXTURES is unset\. No doc names it\.$/m);
  assert.match(r.stderr, /^next: learn-from-mistakes-axi report --full   # the evidence ids/m);
  // The bare report counts the run's labels and names their source; the findings show as counts, their summaries in status only.
  const bare = lfm({}, 'report', '--json');
  assert.equal(bare.status, 0, bare.stderr);
  const bareJson = JSON.parse(bare.stdout);
  assert.deepEqual([bareJson.labels_from, bareJson.coverage.labelled, bareJson.causes[1].cause, bareJson.causes[1].log.incidents, bareJson.findings], [`run ${run.id}`, 2, 'shared-cache-lock', 2, [{ cause: finding.cause, count: 1, days: 1, verdict: 'confirmed' }]]);
  assert.doesNotMatch(bare.stdout, /UMER_FIXTURES|failed for Umer/);
  assert.match(bare.stderr, new RegExp(`^next: learn-from-mistakes-axi status --run ${run.id}   # the run and its steps`, 'm'));
  const toon = lfm({}, 'report');
  assert.equal(toon.status, 0, toon.stderr);
  assert.ok(toon.stdout.split('\n').includes(`finding: ${finding.cause} (1/1 days, confirmed): ${finding.summary}`), toon.stdout);
  // A worker that was asked keeps none of its labels: the report counts none, not the labels.jsonl left in the state dir.
  writeFileSync(join(p, '.lfm', 'labels.jsonl'), readFileSync(join(p, 'labels.jsonl')));
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
  assert.deepEqual(b.steps.map((s) => s.status), ['completed', 'completed', 'completed', 'completed', 'failed', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.match(bad.stderr, new RegExp(`^next: learn-from-mistakes-axi rerun --resume --run ${b.run.id}   # finish it after fixing the analyse step`, 'm'));
  assert.deepEqual(lines(b.run.id).slice(1), ['worker answer 1 is not valid: the answer holds no JSON object', `worker claude ${MODELS.claude[0]}: answered, 12 tokens in, 5 out`,
    'worker answer 2 is not valid: the answer holds no JSON object', `error: ${why}`]);
  assert.match(calls().at(-1).stdin, /\nYour last answer was not valid: the answer holds no JSON object\. Answer again with one JSON object that fixes this\.\n/);
  assert.deepEqual(query('SELECT exit_status FROM invocations WHERE run_id = ?', b.run.id), [{ exit_status: 'invalid' }, { exit_status: 'invalid' }]);
  assert.deepEqual(query('SELECT count(*) AS n FROM labels WHERE run_id = ?', b.run.id), [{ n: 0 }]);
  // An empty answer is a bad answer too: sent back once, then the step fails with the same line.
  const blank = lfm({ FAKE_ANALYSE: 'blank' }, 'retro', '--foreground', '--json');
  assert.equal(blank.status, 1, blank.stderr);
  const e = JSON.parse(blank.stdout).run;
  assert.equal(e.error, "analyse: the worker's answer is not valid after one retry: the answer is empty");
  assert.deepEqual(query('SELECT exit_status FROM invocations WHERE run_id = ?', e.id), [{ exit_status: 'invalid' }, { exit_status: 'invalid' }]);
  // caps.invocations: the run makes no call past it.
  appendFileSync(join(p, '.learn-from-mistakes.yaml'), 'caps: { invocations: 3 }\n');
  const capped = lfm({ FAKE_ANALYSE: 'prose' }, 'rerun', '--resume', '--run', String(b.run.id), '--wait', '1m', '--json');
  assert.equal(capped.status, 1, capped.stderr);
  assert.equal(JSON.parse(capped.stdout).run.error, `analyse: caps.invocations reached: run ${b.run.id} already made 3 agent calls`);
  assert.equal(query('SELECT count(*) AS n FROM invocations WHERE run_id = ?', b.run.id)[0].n, 3);

  // A worker killed during the agent call: status marks the run interrupted and ends the agent's process group.
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8').replace('caps: { invocations: 3 }\n', ''));
  const started = lfm({ FAKE_ANALYSE: 'hang' }, 'retro', '--json');
  assert.equal(started.status, 0, started.stderr);
  const h = JSON.parse(started.stdout).run;
  after(() => { try { process.kill(h.pid, 'SIGKILL'); } catch {} });
  let pgid;
  for (let i = 0; i < 100 && !pgid; i++) { await new Promise((ok) => setTimeout(ok, 200)); pgid = existsSync(join(p, '.lfm', 'lfm.sqlite')) && query('SELECT child_pgid FROM invocations WHERE run_id = ?', h.id)[0]?.child_pgid; }
  assert.ok(pgid, 'the agent call never started');
  after(() => { try { process.kill(-pgid, 'SIGKILL'); } catch {} });
  process.kill(h.pid, 'SIGKILL');
  for (let i = 0; i < 50 && JSON.parse(lfm({}, 'status', '--json').stdout).run.status === 'running'; i++) await new Promise((ok) => setTimeout(ok, 100));
  const k = JSON.parse(lfm({}, 'status', '--json').stdout);
  assert.deepEqual([k.run.status, k.run.error], ['interrupted', 'analyse: the worker stopped before the step ended']);
  assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' }, 'the agent outlived the run');
  assert.deepEqual(query('SELECT exit_status FROM invocations WHERE run_id = ?', h.id), [{ exit_status: 'interrupted' }]);

  // A worker that is not set, or set to an agent that is not ready, stops the run with the fix: the run never picks one.
  const nobin = join(p, '..', 'nobin');
  mkdirSync(nobin);
  symlinkSync(process.execPath, join(nobin, 'node'));
  symlinkSync(join(bin, 'git'), join(nobin, 'git'));
  symlinkSync(FAKE_AGENT, join(nobin, 'codex')); // a ready judge, so the run starts; claude is missing, the worker's problem
  const fix = `ask the user which agent and model to use, then set agent and its agent_config model in ${global}; the run never picks one`;
  const missing = lfm({ PATH: nobin }, 'retro', '--foreground', '--json');
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(JSON.parse(missing.stdout).run.error, new RegExp(`^analyse: worker: .+; ${fix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const runs = query('SELECT count(*) AS n FROM runs')[0].n, set = readFileSync(global, 'utf8');
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
  assert.deepEqual(lines('verify', run.id), ['judge codex gpt-6-luna: answered', 'refuted: p2', 'weakened: p3', 'verdicts: 7 confirmed, 1 weakened, 1 refuted, 0 not judged']);
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

  // Explicit sign-off handoff: absent peer prints findings, a peer gets only contract-v1 fields.
  assert.deepEqual(query('SELECT DISTINCT kind FROM proposals WHERE run_id = ?', run.id), [{ kind: 'code' }]);
  const fallback = lfm({}, 'signoff', 'post');
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.match(fallback.stdout, /Repeated cause: shared-cache-lock[\s\S]*2 incidents over 1 days\.[\s\S]*npm i -g sign-off-axi/);
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
  assert.deepEqual(lines('verify', second.id), ['nothing to verify: no finding and no fix']);
  assert.deepEqual(lines('check', second.id), ['fixes: 0 kept of 0, problems: 0']);
});

function applyRepo() {
  const s = agentSetup(), yaml = join(s.p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }'));
  writeFileSync(join(s.p, 'AGENTS.md'), '# Rules\n\n- Run the tests before a PR.\n');
  s.git = (...args) => execFileSync(join(s.bin, 'git'), ['-C', s.p, ...args], { encoding: 'utf8' }).trim();
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Umer'], ['config', 'user.email', 'umer@example.com'], ['add', '-A'], ['commit', '-qm', 'start']]) s.git(...a);
  s.global = join(s.env.LFM_HOME, 'config.yaml');
  s.auto = (v) => writeFileSync(s.global, `${readFileSync(s.global, 'utf8')}auto_fix: ${v}\n`);
  s.fake = { FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_TARGET: 'AGENTS.md (the rules list)' };
  return s;
}

test('apply: the worker makes an accepted fix on its own branch from HEAD and records it; Skip, a dirty tree and no file refuse; auto_fix applies in the run', () => {
  const { p, global, lfm, query, calls, lines, git, fake, auto } = applyRepo();
  const rules = '# Rules\n\n- Run the tests before a PR.\n';
  const head = git('rev-parse', 'HEAD');
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  assert.deepEqual(lines('apply', run.id), ['auto_fix: 0, so nothing is applied: answer Apply on a fix, then learn-from-mistakes-axi apply']);
  const none = lfm({}, 'apply'); assert.equal(none.status, 3, none.stderr);
  assert.match(none.stderr, new RegExp(`^error: run ${run.id} has no fix answered Apply\nnext: learn-from-mistakes-axi apply --run ${run.id} --fix <n>`, 'm'));
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.prepare(`INSERT INTO signoff (proposal_id, message, answer) SELECT id, '{}', CASE n WHEN 1 THEN 'apply' ELSE 'skip' END FROM proposals WHERE run_id = ? AND n IN (1, 2)`).run(run.id);
  db.prepare(`UPDATE proposals SET target = 'the launch script' WHERE run_id = ? AND n = 3`).run(run.id); db.close();
  writeFileSync(join(p, 'notes.txt'), 'Umer is still writing this.\n');
  const dirty = lfm({}, 'apply'); assert.equal(dirty.status, 1, dirty.stderr);
  assert.match(dirty.stderr, /has uncommitted changes; apply never touches them\nnext: git status/);
  rmSync(join(p, 'notes.txt'));
  const before = calls().length, ok = lfm({}, 'apply');
  assert.equal(ok.status, 0, ok.stderr);
  const commit = git('rev-parse', `lfm/${run.id}-1`);
  assert.equal(ok.stdout, `applied: fix ${run.id}:1 on branch lfm/${run.id}-1, commit ${commit.slice(0, 12)}, ledger chg-1\n`);
  assert.match(ok.stderr, new RegExp(`^next: git diff HEAD\\.\\.\\.lfm/${run.id}-1   # review it`, 'm'));
  // The branch holds one commit on HEAD with the worker's edit; the user's branch, index and work tree are untouched.
  assert.deepEqual([git('rev-parse', `lfm/${run.id}-1^`), git('rev-parse', 'HEAD'), git('branch', '--show-current'), git('status', '--porcelain')], [head, head, 'main', '']);
  assert.equal(readFileSync(join(p, 'AGENTS.md'), 'utf8'), rules);
  assert.equal(git('show', `lfm/${run.id}-1:AGENTS.md`), `${rules}- Give each worker its own cache directory, Umer.`);
  assert.deepEqual(git('diff', '--name-only', `HEAD..lfm/${run.id}-1`), 'AGENTS.md');
  // One fresh tool-off call to the worker, never the judge, with the fix and the file: no bundle and no record text.
  const call = calls().at(-1); assert.equal(calls().length, before + 1);
  assert.ok(call.stdin.startsWith(`lfm-run:${run.id}:apply-1\nYou are the worker of a retro. The user accepted the fix below.`), call.stdin.slice(0, 200));
  assert.ok(call.args.includes('--tools') && call.stdin.includes(`--- AGENTS.md\n${rules}\n--- end of AGENTS.md`) && !call.stdin.includes('# Retro bundle'));
  for (const { text } of query('SELECT text FROM records WHERE run_id = ?', run.id)) assert.ok(!call.stdin.includes(text.trim()), 'record text reached the apply call');
  assert.ok(!calls('codex').some((c) => c.stdin.includes(':apply-')), 'the judge applied a fix');
  assert.deepEqual(query(`SELECT role, runner, exit_status FROM invocations WHERE run_id = ? AND step = 'apply-1'`, run.id), [{ role: 'worker', runner: 'claude', exit_status: 'ok' }]);
  const [chg] = JSON.parse(lfm({}, 'changes', '--json').stdout).changes;
  assert.deepEqual([chg.id, chg.cause, chg.ref, chg.kind, chg.what], ['chg-1', 'shared-cache-lock', commit, 'code', `fix ${run.id}:1 on branch lfm/${run.id}-1`]);
  assert.equal(lfm({}, 'apply').stdout, ok.stdout);
  assert.equal(calls().length, before + 1);
  for (const [n, code, error] of [[2, 2, `fix ${run.id}:2 was answered Skip, and a Skip is never applied`], [3, 1, `fix ${run.id}:3 names no tracked file in its target, so the worker has nothing to edit`], [9, 2, `run ${run.id} has no kept fix 9`]]) {
    const r = lfm({}, 'apply', '--fix', String(n));
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, new RegExp(`^error: ${error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
  assert.ok(!git('branch', '--list', 'lfm/*').includes('-2') && JSON.parse(lfm({}, 'changes', '--json').stdout).changes.length === 1);
  auto(-1);
  assert.match(lfm({}, 'apply').stderr, /auto_fix must be a whole number, 0 or more \(0 = propose only\)/);
  writeFileSync(global, readFileSync(global, 'utf8').replace('auto_fix: -1', 'auto_fix: 1'));
  const auto1 = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  assert.deepEqual(auto1.applied, [{ fix: 1, branch: `lfm/${auto1.run.id}-1`, commit: git('rev-parse', `lfm/${auto1.run.id}-1`), change: 'chg-2' }]);
  assert.deepEqual([git('rev-parse', `lfm/${auto1.run.id}-1^`), git('branch', '--show-current'), git('status', '--porcelain')], [head, 'main', '']);
});

test('auto_fix is a user setting: a project file that sets it exits 2 and a retro does not start', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `${readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8')}auto_fix: 3\n`);
  const r = lfm('retro', '--foreground'); assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: .*auto_fix is a user setting; set it in the global config$/m);
  assert.ok(!existsSync(join(p, '.lfm', 'lfm.sqlite')), 'a refused config must not create the store');
});

test('apply: with no saved store, apply names the empty store and exits 3', () => {
  const r = agentSetup().lfm({}, 'apply', '--run', '1'); assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /^error: no retro run has kept fixes$/m);
});

test('apply: a refused apply in the run logs one line and the run stays ok with its proposals', () => {
  const { p, lfm, query, lines, fake, auto } = applyRepo();
  auto(1);
  writeFileSync(join(p, 'notes.txt'), 'Umer is still writing this.\n'); // the user's uncommitted work refuses the apply
  const r = lfm(fake, 'retro', '--foreground', '--json'); assert.equal(r.status, 0, r.stderr);
  const { run, applied } = JSON.parse(r.stdout);
  assert.deepEqual([run.status, applied], ['completed', []]);
  const refused = lines('apply', run.id);
  assert.equal(refused.length, 1, refused.join('\n'));
  assert.match(refused[0], new RegExp(`^refused: fix ${run.id}:1 was not applied: .* has uncommitted changes; apply never touches them$`));
  assert.ok(query('SELECT count(*) AS n FROM proposals WHERE run_id = ? AND n IS NOT NULL', run.id)[0].n > 0);
});

test('apply: a kept fix naming a cause that is not configured is refused in the run, with no branch', () => {
  const { p, lfm, lines, git, fake, auto } = applyRepo();
  const { run } = JSON.parse(lfm(fake, 'retro', '--foreground', '--json').stdout);
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.exec(`UPDATE proposals SET cause = 'unlisted-cause' WHERE run_id = ${run.id} AND n = 1; UPDATE steps SET status = 'failed' WHERE run_id = ${run.id} AND name = 'apply'; UPDATE runs SET status = 'failed' WHERE id = ${run.id};`);
  db.close();
  auto(1);
  const r = lfm(fake, 'rerun', '--resume', '--run', String(run.id), '--wait', '1m', '--json'); assert.equal(r.status, 0, r.stderr);
  const resumed = JSON.parse(r.stdout);
  assert.deepEqual([resumed.run.status, resumed.applied], ['completed', []]);
  const refused = lines('apply', run.id);
  assert.equal(refused.length, 1, refused.join('\n'));
  assert.match(refused[0], new RegExp(`^refused: fix ${run.id}:1 was not applied: .* names cause unlisted-cause, which is not a configured cause$`));
  assert.equal(git('branch', '--list', 'lfm/*'), '');
});

test('retro and rerun stop before a run when the judge resolves to the worker\'s agent and model, or is not ready', () => {
  const { p, env, lfm } = agentSetup();
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), `agent: claude\njudge_agent: claude\nagent_config: { claude: { model: claude-haiku-5-5 } }\n`);
  for (const cmd of ['retro', 'rerun']) {
    const r = lfm({}, cmd);
    assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /^error: judge: agent_config holds one model per agent, so a judge on the worker's agent gets the worker's model and would judge its own work\nnext: ask the user which agent and model to use, then set judge_agent and its agent_config model in /m);
  }
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), `agent: claude\njudge_agent: acp:claude\nagent_config: { claude: { model: claude-haiku-5-5 }, "acp:claude": { model: claude-haiku-5-5 } }\n`);
  for (const cmd of ['retro', 'rerun']) {
    const r = lfm({}, cmd);
    assert.equal(r.status, 1, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /^error: judge: acp:claude is not usable: acpx is not on PATH$/m);
  }
  assert.ok(!existsSync(join(p, '.lfm', 'lfm.sqlite')), 'a run started');
});

test('a fix the judge leaves out is not judged: it ranks after the confirmed fixes and status reads not judged', () => {
  const { p, lfm, query, lines } = agentSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace(/^repeat: .*$/m, 'repeat: { min_incidents: 2, min_days: 1 }\ntargets: { defects: "<= 0" }'));
  const r = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_REFUTE: 'p2', FAKE_UNJUDGED: 'p1' }, 'retro', '--foreground', '--json');
  assert.equal(r.status, 0, r.stderr);
  const { run } = JSON.parse(r.stdout);
  assert.deepEqual(lines('verify', run.id), ['judge codex gpt-6-luna: answered', 'judge answer 1 is not valid: verdicts has no verdict for p1', 'judge codex gpt-6-luna: answered',
    'refuted: p2', 'verdicts: 7 confirmed, 0 weakened, 1 refuted, 1 not judged']);
  assert.deepEqual(query('SELECT target, n, verdict FROM proposals WHERE run_id = ? AND n IS NOT NULL ORDER BY n', run.id), [
    { target: 'launch script 6', n: 1, verdict: 'confirmed' }, { target: 'launch script 3', n: 2, verdict: 'confirmed' }, { target: 'launch script 4', n: 3, verdict: 'confirmed' },
    { target: 'launch script 5', n: 4, verdict: 'confirmed' }, { target: 'launch script 1', n: 5, verdict: null }]);
  const { fixes } = JSON.parse(lfm({}, 'status', '--json', '--run', String(run.id)).stdout);
  assert.deepEqual(fixes.map((f) => [f.n, f.verdict]), [[1, 'confirmed'], [2, 'confirmed'], [3, 'confirmed'], [4, 'confirmed'], [5, 'not judged']]);
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
  assert.match(lfm({}, 'report').stdout, /^finding: umer-fixtures-unset \(0\/0 days, refuted\): /m);
  const badKind = lfm({ FAKE_ANALYSE: 'label', FAKE_CAUSE: 'shared-cache-lock', FAKE_PROPOSE: 'eight', FAKE_KIND: 'guess' }, 'retro', '--foreground', '--json');
  assert.equal(badKind.status, 0, badKind.stderr);
  const badId = JSON.parse(badKind.stdout).run.id;
  assert.match(calls().at(-1).stdin, /Your last answer was not valid: proposals\[0\]\.kind must be doc, rule or code/);
  assert.equal(query('SELECT count(*) AS n FROM proposals WHERE run_id = ?', badId)[0].n, 0);
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
  const code = await closed;
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
