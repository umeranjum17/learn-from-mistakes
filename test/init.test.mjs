// End-to-end: the real CLI runs `init` in a throwaway git repo, with fake agent CLIs (PATH holds only them), a throwaway
// HOME (with an empty Claude Code session store) and LFM_HOME, and a synthetic no-mistakes store under NM_HOME that has a row
// for the repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parse } from 'yaml';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const MODELS = JSON.parse(readFileSync(new URL('../src/models.json', import.meta.url), 'utf8'));

function setup(agents, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-init-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'umer-app'), bin = join(tmp, 'bin'), nm = join(tmp, 'nm');
  for (const d of [join(p, 'docs'), bin, nm, join(tmp, 'home', '.claude', 'projects')]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['-C', p, 'init', '-q']);
  writeFileSync(join(p, 'docs', 'defects.md'), readFileSync(new URL('../examples/defects.md', import.meta.url)));
  for (const name of agents) {
    writeFileSync(join(bin, name), '#!/bin/sh\necho "1.0.0"\n');
    chmodSync(join(bin, name), 0o755);
  }
  copyFileSync(new URL('../examples/gate.sqlite', import.meta.url), join(nm, 'state.sqlite'));
  const db = new DatabaseSync(join(nm, 'state.sqlite'));
  db.exec('CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL, upstream_url TEXT NOT NULL)');
  db.prepare('INSERT INTO repos VALUES (?, ?, ?)').run('r1', realpathSync(p), 'https://example.com/umer/umer-app.git');
  db.close();
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), NM_HOME: nm, ...extraEnv };
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  const config = join(p, '.learn-from-mistakes.yaml');
  return { p, nm, lfm, config, env };
}

test('init writes a working config once: a worker and a different judge, the sources found, a git-ignored .lfm', () => {
  const { p, nm, lfm, config } = setup(['claude', 'opencode']);
  const r = lfm('init', '-y', '--no-skill', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'written');
  assert.deepEqual([out.worker, out.judge], [{ runner: 'claude', model: MODELS.claude[0] }, { runner: 'opencode', model: MODELS.opencode[0] }]);
  assert.deepEqual(out.gaps, []);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual(yaml, { name: 'umer-app', worker: { runner: 'claude', model: '' }, judge: { runner: 'opencode', model: '' }, excerpts: 'on',
    sources: { log: { type: 'markdown-log', path: 'docs/defects.md' }, gate: { type: 'no-mistakes', path: join(nm, 'state.sqlite') },
      sessions: { type: 'sessions', agents: ['auto'] } } });
  assert.equal(readFileSync(join(p, '.lfm', '.gitignore'), 'utf8'), '*\n');
  assert.equal(execFileSync('git', ['-C', p, 'status', '--short'], { encoding: 'utf8' }), '?? .learn-from-mistakes.yaml\n?? docs/\n');
  const text = lfm('init');
  assert.match(text.stdout, /^excerpts on: the worker \(claude\) and the judge \(opencode\) see redacted record excerpts/m);

  const bytes = readFileSync(config);
  const again = lfm('init', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).status, 'already set up');
  assert.deepEqual(readFileSync(config), bytes);
  const run = lfm('retro', '--foreground', '--json'); // the written config runs: every detected source is read
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).run.status, 'completed');

  writeFileSync(config, 'sources: {}\n'); // an existing config is never rewritten; its gaps are listed
  const gaps = JSON.parse(lfm('init', '--json').stdout);
  assert.deepEqual(gaps.gaps, ['sources: markdown-log found at docs/defects.md, not configured (add it as log)',
    'sources: no-mistakes found at ' + join(nm, 'state.sqlite') + ', not configured (add it as gate)',
    'sources: sessions found, not configured (add it as sessions)']);
  assert.equal(readFileSync(config, 'utf8'), 'sources: {}\n');
  rmSync(config);
  assert.equal(lfm('init', '--no-excerpts').status, 0);
  assert.equal(parse(readFileSync(config, 'utf8')).excerpts, 'off');
});

test('one agent CLI with one table model: the judge is written on the worker\'s identity and reported, never a silent fallback', () => {
  const { lfm, config } = setup(['claude']);
  const r = lfm('init', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).gaps, ['judge: the judge resolves to the worker\'s agent and model, so it would judge its own work']);
  assert.match(r.stderr, /^next: set judge\.runner and judge\.model in \.learn-from-mistakes\.yaml to an agent CLI and a different model, or install a second agent CLI$/m);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).judge, { runner: 'claude', model: '' });
  const agents = lfm('agents'); // the clash fails every later check of the config
  assert.equal(agents.status, 1);
  assert.match(agents.stderr, /^problem: judge: the judge resolves to the worker's agent/m);
});

test('a pinned judge steers the auto worker onto a different agent CLI, and the pair is written', () => {
  const { lfm, config } = setup(['claude', 'codex']);
  const r = lfm('init', '--judge', 'claude', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.worker, out.judge], [{ runner: 'codex', model: MODELS.codex[0] }, { runner: 'claude', model: MODELS.claude[0] }]);
  assert.deepEqual(out.gaps, []);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).worker, { runner: 'codex', model: '' });
});

test('an empty or relative PATH entry never runs an agent CLI from the project dir', () => {
  const { p, env, config } = setup([]);
  writeFileSync(join(p, 'claude'), '#!/bin/sh\necho ran > ran.txt\necho "1.0.0"\n');
  writeFileSync(join(p, 'git'), '#!/bin/sh\necho ran > ran-git.txt\n');
  chmodSync(join(p, 'claude'), 0o755);
  chmodSync(join(p, 'git'), 0o755);
  for (const PATH of [`${env.PATH}:`, `.:${env.PATH}`]) {
    const r = spawnSync(process.execPath, [CLI, 'init', '--dir', p, '--json'], { encoding: 'utf8', cwd: p, env: { ...env, PATH } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^error: worker: no usable agent CLI/m);
    assert.ok(!existsSync(join(p, 'ran.txt')), `the project-dir claude ran with PATH ${PATH}`);
    assert.ok(!existsSync(join(p, 'ran-git.txt')), `the project-dir git ran with PATH ${PATH}`);
    assert.ok(!existsSync(config));
  }
});

test('an existing config with no agent CLI at all says how to install one', () => {
  const { lfm, config } = setup([]);
  writeFileSync(config, 'sources: {}\n');
  const r = lfm('init');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^next: install claude, codex, opencode, pi or gemini, or set runner_path/m);
});

test('LFM_MODEL is a run-time override: init writes the same pair with it set', () => {
  const { lfm, config } = setup(['claude', 'codex'], { LFM_MODEL: 'my-own-model' });
  const r = lfm('init', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.worker, out.judge], [{ runner: 'claude', model: MODELS.claude[0] }, { runner: 'codex', model: MODELS.codex[0] }]);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).worker, { runner: 'claude', model: '' });
});

test('an unusable judge is not named as seeing excerpts', () => {
  const { lfm, config } = setup(['claude']);
  writeFileSync(config, 'judge: { runner: codex, model: "" }\n');
  const r = lfm('init');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^excerpts on: the worker \(claude\) and the judge \(no usable runner\) see redacted record excerpts/m);
});

test('init refuses a pinned judge on the worker\'s identity, an unknown runner and no agent CLI, and writes nothing', () => {
  const { lfm, config } = setup(['claude', 'opencode', 'gemini']);
  for (const [args, code, error] of [
    [['--worker', 'claude', '--judge', 'claude'], 2, 'error: judge: the judge resolves to the worker\'s agent and model, so it would judge its own work'],
    [['--worker', 'umer'], 2, 'error: --worker "umer" must be a runner: claude, codex, opencode, pi, gemini or acp:<target>'],
    [['--judge', 'codex'], 1, 'error: judge: codex is not usable: codex is not on PATH'],
    [['--judge', 'gemini'], 1, 'error: judge: gemini is not offered: its read-only plan mode is not yet confirmed in headless mode (agents --test gemini runs the write test)'],
  ]) {
    const r = lfm('init', ...args);
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.stderr.split('\n')[0], error);
    assert.match(r.stderr, /^next: /m);
    assert.ok(!existsSync(config), `${args.join(' ')} wrote a config`);
  }
  writeFileSync(config, 'sources: {}\n'); // an existing config is never rewritten: the flags that would change it are reported
  const pinned = lfm('init', '--worker', 'opencode', '--judge', 'claude', '--json');
  assert.equal(pinned.status, 0, pinned.stderr);
  const { status, ignored } = JSON.parse(pinned.stdout);
  assert.deepEqual([status, ignored], ['already set up', ['--worker', '--judge']]);
  assert.match(lfm('init', '--no-excerpts').stdout, /^--no-excerpts not applied: \.learn-from-mistakes\.yaml exists \(edit it to change them\)$/m);
  assert.equal(readFileSync(config, 'utf8'), 'sources: {}\n');
  const missing = spawnSync(process.execPath, [CLI, 'init', '--dir', join(config, 'nope')], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: .*nope: not a directory\nnext: /);
  const none = setup([]).lfm('init');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: worker: no usable agent CLI/);
});

// doctor after init: every check ok or warn, exit 0; then a missing defect log, a judge on the worker's identity and
// a premium model are 3 fail lines, each with its fix, exit 1; after the fixes, exit 0 again. Login checks run the
// agent's own status command (pi's never refreshes a token) and print no credential text.
test('doctor names each fail with its fix and exits 1 until the fixes are made', () => {
  const { p, lfm, config, env } = setup(['claude', 'opencode', 'pi', 'gemini']);
  const fake = (name, body) => { writeFileSync(join(env.PATH, name), `#!/bin/sh\n${body}\necho "1.0.0"\n`); chmodSync(join(env.PATH, name), 0o755); };
  fake('opencode', 'if [ "$1 $2" = "auth list" ]; then echo "Anthropic api sk-ant-UMERCANARY"; echo "1 credentials"; exit 0; fi');
  fake('pi', `if [ "$1" = auth ]; then echo "$*" > "${join(p, '..', 'pi-argv')}"; echo sk-UMERCANARY; exit 0; fi`);
  symlinkSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), join(env.PATH, 'git'));
  writeFileSync(join(env.HOME, '.claude', '.credentials.json'), '{"token":"sk-ant-UMERCANARY"}');
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  const doctor = () => {
    const r = lfm('doctor', '--json');
    assert.doesNotMatch(r.stdout + r.stderr, /UMERCANARY/);
    return { ...r, out: JSON.parse(r.stdout) };
  };
  const ok = doctor();
  assert.equal(ok.status, 0, ok.stdout);
  const level = (out, label) => out.checks.find((c) => c.label === label)?.level;
  assert.deepEqual(['config', 'state', 'source log', 'source gate', 'worker', 'worker login', 'judge login', 'identity'].map((l) => level(ok.out, l)), Array(8).fill('ok'));
  assert.equal(ok.out.checks.find((c) => c.label === 'judge login').detail, 'opencode auth list: logged in');
  assert.deepEqual(['skill claude', 'sign-off'].map((l) => level(ok.out, l)), ['warn', 'warn']);
  assert.match(lfm('doctor').stderr, /^next: learn-from-mistakes-axi retro --wait 8m/m);

  const yaml = readFileSync(config, 'utf8');
  rmSync(join(p, 'docs', 'defects.md'));
  writeFileSync(config, yaml.replace(/^worker: .*$/m, 'worker: { runner: pi, model: claude-opus-5-5 }').replace(/^judge: .*$/m, 'judge: { runner: pi, model: "" }'));
  const bad = doctor();
  assert.equal(bad.status, 1);
  const fails = bad.out.checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['source log', 'worker model', 'identity']);
  assert.ok(fails.every((c) => c.fix), 'a fail with no fix');
  assert.ok(fails[0].fix.startsWith(`check sources.log.path in ${config}, or create it: touch `), fails[0].fix);
  assert.ok(fails[1].fix.endsWith(`allow_premium: true in ${config}`), fails[1].fix);
  assert.equal(readFileSync(join(p, '..', 'pi-argv'), 'utf8'), 'auth check --no-refresh --model claude-opus-5-5\n');
  const text = lfm('doctor');
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^fail identity +the worker \(pi [^)]*\) and the judge \(pi\) resolve to the same agent and model.*\n {5}fix: set judge\.runner/m);
  assert.match(text.stderr, /^next: learn-from-mistakes-axi doctor   # again after the 3 fixes above/m);

  writeFileSync(join(p, 'docs', 'defects.md'), '- 2026-10-12 umer: a synthetic defect\n');
  writeFileSync(config, yaml.replace(/^worker: .*$/m, 'worker: { runner: pi, model: umer-cheap-1 }'));
  const fixed = doctor();
  assert.equal(fixed.status, 0, fixed.stdout);
  assert.equal(fixed.out.fails, 0);
});

test('doctor fails a worker pinned to a runner that is not offered, and asks to set it to another agent CLI', () => {
  const { lfm, config } = setup(['claude', 'gemini']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: gemini, model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.match(fails[0].detail, /^gemini is not offered: /);
  assert.equal(fails[0].fix, `set worker.runner in ${config} to another agent CLI`);
});

test('doctor names an unconfirmed pinned worker\'s reason and a set-runner fix, not a second CLI, when the judge takes the only other CLI', () => {
  const { lfm, config } = setup(['claude', 'gemini']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: gemini, model: "" }').replace(/^judge: .*$/m, 'judge: { runner: auto, model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.match(fails[0].detail, /^gemini is not offered: /);
  assert.equal(fails[0].fix, `set worker.runner in ${config} to another agent CLI`);
});

test('doctor names a usable runner that does not clash with the other role in a pinned-role fix', () => {
  const { lfm, config } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: gemini, model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `set worker.runner in ${config} to claude`);
});

test('doctor names the config file in its fix when that file is not a mapping', () => {
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, 'just a scalar\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fail = JSON.parse(r.stdout).checks.find((c) => c.label === 'config');
  assert.equal(fail.fix, `edit ${config}   # then run doctor again`);
});

test('init prints a BYOKit worker problem with the route list in its error', () => {
  const { lfm } = setup(['claude']);
  const r = lfm('init', '-y', '--no-skill', '--worker', 'byokit:nope');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /worker: byokit:nope is not a BYOKit plan route: use one of: byokit:/);
});

test('init refuses a judge on a BYOKit route that is not a plan route, with the --worker and --judge hint and exit 2', () => {
  const { lfm, config } = setup(['claude']);
  const r = lfm('init', '-y', '--no-skill', '--worker', 'claude', '--judge', 'byokit:nope');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /judge: byokit:nope is not a BYOKit plan route: use one of: byokit:/);
  assert.match(r.stderr, /^next: learn-from-mistakes-axi init --worker <runner> --judge byokit:nope/m);
  assert.equal(existsSync(config), false);
});

test('doctor run from another directory names the full project file in each fix', () => {
  const { p, lfm, config, env } = setup(['claude', 'opencode']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  rmSync(join(p, 'docs', 'defects.md'));
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--json', '--dir', p], { encoding: 'utf8', env, cwd: env.HOME });
  assert.equal(r.status, 1, r.stderr);
  const fail = JSON.parse(r.stdout).checks.find((c) => c.level === 'fail');
  assert.equal(fail.label, 'source log');
  assert.ok(fail.fix.startsWith(`check sources.log.path in ${config}, or create it: touch `), fail.fix);
  const ingest = spawnSync(process.execPath, [CLI, 'ingest', '--dir', p], { encoding: 'utf8', env, cwd: env.HOME });
  assert.equal(ingest.status, 2, ingest.stderr);
  assert.ok(ingest.stderr.includes(`next: check sources.log.path in ${config}, or create it: touch `), ingest.stderr);
});

test('doctor warns on a sessions source whose agent has no store, and names that agent\'s store variable', () => {
  const { lfm, config, env } = setup(['claude', 'opencode']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  const yaml = readFileSync(config, 'utf8');
  writeFileSync(config, yaml.replace(/(sessions:[\s\S]*?agents:)\s*(\[[^\]]*\]|(\n\s+- .*)+)/, '$1 [codex]'));
  const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'source sessions');
  assert.equal(line.level, 'warn');
  assert.equal(line.detail, `sessions: no session store at ${join(env.HOME, '.codex', 'state_5.sqlite')}`);
  assert.equal(line.fix, `export CODEX_HOME=<dir>   # if a store is somewhere else, or drop it from sources.sessions.agents in ${config}`);
});

test('doctor names an absent store of an auto agent as information, and warns on one a config lists', () => {
  const { lfm, config, env } = setup(['claude', 'opencode']);
  mkdirSync(join(env.HOME, '.local', 'share', 'opencode'), { recursive: true });
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  const sessions = () => JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'source sessions');
  const auto = sessions();
  assert.equal(auto.level, 'ok');
  assert.match(auto.detail, new RegExp(`; codex store not found at ${join(env.HOME, '.codex', 'state_5.sqlite').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(CODEX_HOME\\)$`));
  assert.equal(auto.fix, undefined);
  const yaml = readFileSync(config, 'utf8');
  writeFileSync(config, yaml.replace(/(sessions:[\s\S]*?agents:)\s*(\[[^\]]*\]|(\n\s+- .*)+)/, '$1 [claude, codex]'));
  const listed = sessions();
  assert.equal(listed.level, 'warn');
  assert.match(listed.detail, /; codex store not found at .*state_5\.sqlite \(CODEX_HOME\)$/);
  assert.equal(listed.fix, `export CODEX_HOME=<dir>   # if a store is somewhere else, or drop it from sources.sessions.agents in ${config}`);
});

test('doctor offers no runner whose model, as the pinned role would use it, clashes with the other role', () => {
  const { lfm, config } = setup(['claude', 'gemini']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: gemini, model: "umer-x" }').replace(/^judge: .*$/m, 'judge: { runner: claude, model: "umer-x" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `set worker.runner in ${config} to another agent CLI`);
});

test('doctor offers no runner whose premium model allow_premium forbids, so the fix does not make a new fail', () => {
  const { lfm, config, env } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: gemini, model: "claude-opus-5-5" }'));
  const fails = JSON.parse(lfm('doctor', '--json').stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `install gemini, or set runner_path in ${join(env.LFM_HOME, 'config.yaml')}`);
});

test('doctor fails an auto worker on a model no installed CLI lists, names a listed model, and that fix makes exit 0', () => {
  const { lfm, config } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: auto, model: "claude-opus-5-5" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `set worker.model in ${config} to ${MODELS.claude[0]}`);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, `worker: { runner: auto, model: "${MODELS.claude[0]}" }`));
  const fixed = lfm('doctor', '--json');
  assert.equal(fixed.status, 0, fixed.stdout);
});

test('doctor names the pinned runner\'s own problem, not a premium fix, when that runner is not on PATH', () => {
  const { lfm, config, env } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: claude, model: "claude-opus-5-5" }'));
  rmSync(join(env.PATH, 'claude'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].detail, 'claude is not usable: claude is not on PATH');
  assert.equal(fails[0].fix, `install claude, or set runner_path in ${join(env.LFM_HOME, 'config.yaml')}`);
});

test('doctor offers only a runner that lists the pinned worker model, never one that would run it with a model it does not list', () => {
  const { lfm, config } = setup(['claude', 'codex', 'gemini']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: gemini, model: "gpt-6-luna" }').replace(/^judge: .*$/m, 'judge: { runner: claude, model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `set worker.runner in ${config} to codex`);
});

test('doctor says to unset LFM_MODEL when the premium model comes from it', () => {
  const { lfm, config } = setup(['claude', 'codex'], { LFM_MODEL: 'claude-opus-5-5' });
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: claude, model: "" }'));
  const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker model');
  assert.equal(line.level, 'fail');
  assert.equal(line.detail, 'claude-opus-5-5 (LFM_MODEL) is a premium model');
  assert.equal(line.fix, 'unset LFM_MODEL, or set allow_premium: true');
});

// A worker on a BYOKit route is checked by BYOKit's own sign-in, not as an agent CLI: a route with no sign-in is a fail
// with the sign-in fix, and doctor runs to the end instead of failing on the missing agent CLI row.
test('doctor checks a BYOKit worker route by its sign-in and names the sign-in fix', () => {
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: "byokit:chatgpt", model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const line = JSON.parse(r.stdout).checks.find((c) => c.label === 'worker login');
  assert.equal(line.level, 'fail');
  assert.match(line.fix, /^sign in to chatgpt through BYOKit .* then: learn-from-mistakes-axi agents --test byokit:chatgpt$/);
});

// A BYOKit worker with no model is checked on the model BYOKit calls (its route default), not the agent CLI table.
test('doctor checks a BYOKit worker with no model on the route default BYOKit calls', async () => {
  const { provider } = await import('@byokit/accounts');
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: "byokit:chatgpt", model: "" }'));
  const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker model');
  assert.deepEqual([line.level, line.detail], ['ok', provider('chatgpt').models.fast]);
});

// A BYOKit route that is not a plan route fails the role itself, with BYOKit's problem and fix; no sign-in line follows.
test('doctor fails a BYOKit worker on a route that is not a plan route, before any sign-in check', () => {
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: "byokit:nope", model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(r.stdout).checks;
  const role = checks.find((c) => c.label === 'worker');
  assert.equal(role.level, 'fail');
  assert.match(role.detail, /^byokit:nope is not a BYOKit plan route/);
  assert.match(role.fix, /^use one of: byokit:/);
  assert.equal(checks.some((c) => c.label === 'worker login'), false);
});

// A BYOKit plan-key route with no model has no catalogue default, and no agent CLI would pick one for it: the model is a
// fail with the config path to set, not an agent-CLI warn.
test('doctor fails a BYOKit worker with no model and no catalogue default, and names the config to set', () => {
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^worker: .*$/m, 'worker: { runner: "byokit:opencode-go", model: "" }'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const line = JSON.parse(r.stdout).checks.find((c) => c.label === 'worker model');
  assert.deepEqual([line.level, line.detail, line.fix], ['fail', 'BYOKit has no default model for opencode-go', `set worker.model in ${config}`]);
});

// Two BYOKit roles on one route are the same identity only when they call the same model: an unset model is the
// catalogue default, so a judge on another model is not a clash, and a judge on that default is.
test('doctor compares BYOKit roles by the model each calls: another model is no clash, the same model is', async () => {
  const { provider } = await import('@byokit/accounts');
  const fast = provider('chatgpt').models.fast;
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  const identity = (judgeModel) => {
    writeFileSync(config, readFileSync(config, 'utf8')
      .replace(/^worker: .*$/m, 'worker: { runner: "byokit:chatgpt", model: "" }')
      .replace(/^judge: .*$/m, `judge: { runner: "byokit:chatgpt", model: "${judgeModel}" }`));
    return JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'identity');
  };
  assert.equal(identity('umer-cheap-1').level, 'ok');
  const clash = identity(fast);
  assert.equal(clash.level, 'fail');
  assert.match(clash.detail, /^the worker \(byokit:chatgpt [^)]*\) and the judge \(byokit:chatgpt [^)]*\) resolve to the same agent and model/);
});

// A pi whose auth check exits non-zero: the login file decides. A present auth.json is a warn with the exit code; an
// absent one is a fail with the login fix. The HOME is synthetic, and the auth.json in it is a placeholder.
for (const [authJson, level, detail] of [[true, 'warn', 'pi auth check failed (exit 3); auth.json present'], [false, 'fail', 'pi auth check failed (exit 3); no auth.json']]) {
  test(`doctor checks pi's login file after a failed auth check: ${authJson ? 'present is a warn' : 'absent is a fail with its fix'}`, () => {
    const { lfm, config, env } = setup(['claude', 'pi']);
    writeFileSync(join(env.PATH, 'pi'), '#!/bin/sh\nif [ "$1" = auth ]; then echo "no session" >&2; exit 3; fi\necho "1.0.0"\n');
    chmodSync(join(env.PATH, 'pi'), 0o755);
    if (authJson) {
      mkdirSync(join(env.HOME, '.pi', 'agent'), { recursive: true });
      writeFileSync(join(env.HOME, '.pi', 'agent', 'auth.json'), '{"placeholder": true}\n');
    }
    assert.equal(lfm('init', '-y', '--no-skill').status, 0);
    const yaml = readFileSync(config, 'utf8');
    writeFileSync(config, yaml.replace(/^worker: .*$/m, 'worker: { runner: pi, model: umer-cheap-1 }').replace(/^judge: .*$/m, 'judge: { runner: claude, model: "" }'));
    const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker login');
    assert.equal(line.level, level);
    assert.equal(line.detail, detail);
    assert.equal(line.fix, level === 'fail' ? 'pi   # then /login' : undefined);
  });
}
