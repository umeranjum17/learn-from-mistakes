// End-to-end: the real CLI runs `init` in a throwaway git repo, with fake agent CLIs (PATH holds only them), a throwaway
// HOME (with an empty Claude Code session store) and LFM_HOME, and a synthetic no-mistakes store under NM_HOME that has a row
// for the repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parse } from 'yaml';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
import { AGENT_DEFAULTS } from '../src/config.mjs';
const MODELS = Object.fromEntries(Object.entries(AGENT_DEFAULTS).map(([a, c]) => [a, [c.model]])); // the cheap default per agent

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
  db.prepare('UPDATE repos SET working_path = ?, upstream_url = ?').run(realpathSync(p), 'https://example.com/umer/umer-app.git');
  db.close();
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), NM_HOME: nm, ...extraEnv };
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  const config = join(p, '.learn-from-mistakes.yaml');
  const keys = (text) => appendFileSync(config, text); // agent keys after the commented ones init wrote
  return { p, nm, lfm, config, env, keys, global: join(env.LFM_HOME, 'config.yaml') };
}

test('init writes the global agent config and a working project config once: a worker and a different judge, the sources found, a git-ignored .lfm', () => {
  const { p, nm, lfm, config, global } = setup(['claude', 'opencode']);
  const r = lfm('init', '-y', '--no-skill', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.status, out.global, out.global_status], ['written', global, 'written']);
  assert.deepEqual([out.worker, out.judge], [{ runner: 'claude', model: MODELS.claude[0] }, { runner: 'opencode', model: MODELS.opencode[0] }]);
  assert.deepEqual(out.gaps, []);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual(parse(readFileSync(global, 'utf8')), { agent: 'auto', judge_agent: 'auto', agent_config: AGENT_DEFAULTS, agent_timeout: '20m' }); // the rest is comments
  assert.match(readFileSync(config, 'utf8'), /^# agent: auto /m); // the project file names the keys it may override, commented
  assert.deepEqual(yaml, { name: 'umer-app', excerpts: 'on',
    sources: { log: { type: 'markdown-log', path: 'docs/defects.md' }, gate: { type: 'no-mistakes', path: join(nm, 'state.sqlite') },
      sessions: { type: 'sessions', agents: ['auto'] } } });
  assert.equal(readFileSync(join(p, '.lfm', '.gitignore'), 'utf8'), '*\n');
  assert.equal(execFileSync('git', ['-C', p, 'status', '--short'], { encoding: 'utf8' }), '?? .learn-from-mistakes.yaml\n?? docs/\n');
  const text = lfm('init');
  assert.match(text.stdout, /^excerpts on: the worker \(claude\) and the judge \(opencode\) see redacted record excerpts/m);

  const bytes = readFileSync(config), globalBytes = readFileSync(global);
  const again = lfm('init', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([JSON.parse(again.stdout).status, JSON.parse(again.stdout).global_status], ['already set up', 'kept']);
  assert.deepEqual(readFileSync(config), bytes);
  assert.deepEqual(readFileSync(global), globalBytes); // never overwritten
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

test('one agent CLI: the judge resolves to the worker\'s identity and is reported, never a silent fallback', () => {
  const { lfm, global } = setup(['claude']);
  const r = lfm('init', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).gaps, ['judge: the judge resolves to the worker\'s agent and model, so it would judge its own work']);
  assert.equal(r.stderr.match(/^next: (.*)$/m)[1], `set judge_agent in ${global} to another agent, or install a second agent CLI`);
  const agents = lfm('agents'); // the clash fails every later check of the config
  assert.equal(agents.status, 1);
  assert.match(agents.stderr, /^problem: judge: the judge resolves to the worker's agent/m);
});

test('a pinned judge steers the auto worker onto a different agent CLI, and the pair is written', () => {
  const { lfm, config } = setup(['claude', 'codex']);
  const r = lfm('init', '--judge-agent', 'claude', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.worker, out.judge], [{ runner: 'codex', model: MODELS.codex[0] }, { runner: 'claude', model: MODELS.claude[0] }]);
  assert.deepEqual(out.gaps, []);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent], [undefined, 'claude']); // only the pinned key is written
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
  assert.match(r.stderr, /^next: install claude, codex, opencode, pi or gemini, or set agent_path_override in .*lfm-home\/config\.yaml/m);
});

test('an unusable judge is not named as seeing excerpts', () => {
  const { lfm, config } = setup(['claude']);
  writeFileSync(config, 'judge_agent: codex\n');
  const r = lfm('init');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^excerpts on: the worker \(claude\) and the judge \(no usable runner\) see redacted record excerpts/m);
});

test('init refuses a pinned judge on the worker\'s identity, an unknown runner and no agent CLI, and writes nothing', () => {
  const { lfm, config, env } = setup(['claude', 'opencode', 'gemini']);
  for (const [args, code, error] of [
    [['--agent', 'claude', '--judge-agent', 'claude'], 2, 'error: judge: the judge resolves to the worker\'s agent and model, so it would judge its own work'],
    [['--agent', 'umer'], 2, 'error: --agent "umer" must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>'],
    [['--judge-agent', 'codex'], 1, 'error: judge: codex is not usable: codex is not on PATH'],
    [['--judge-agent', 'gemini'], 1, 'error: judge: gemini is not offered: its read-only plan mode is not yet confirmed in headless mode (agents --test gemini runs the write test)'],
  ]) {
    const r = lfm('init', ...args);
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.stderr.split('\n')[0], error);
    assert.match(r.stderr, /^next: /m);
    assert.ok(!existsSync(config), `${args.join(' ')} wrote a config`);
    assert.ok(!existsSync(join(env.LFM_HOME, 'config.yaml')), `${args.join(' ')} wrote the global config`);
  }
  writeFileSync(config, 'sources: {}\n'); // an existing config is never rewritten: the flags that would change it are reported
  const pinned = lfm('init', '--agent', 'opencode', '--judge-agent', 'claude', '--json');
  assert.equal(pinned.status, 0, pinned.stderr);
  const { status, ignored } = JSON.parse(pinned.stdout);
  assert.deepEqual([status, ignored], ['already set up', ['--agent', '--judge-agent']]);
  assert.match(lfm('init', '--no-excerpts').stdout, /^--no-excerpts not applied: \.learn-from-mistakes\.yaml exists \(edit it to change them\)$/m);
  assert.equal(readFileSync(config, 'utf8'), 'sources: {}\n');
  const missing = spawnSync(process.execPath, [CLI, 'init', '--dir', join(config, 'nope')], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: .*nope: not a directory\nnext: /);
  const none = setup([]).lfm('init');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: worker: no usable agent CLI/);
});

test('init finds the no-mistakes repo of a git worktree of the project, as the source reads it', () => {
  const { p, nm, env } = setup(['claude']);
  const git = (...args) => execFileSync('git', ['-C', p, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(dirname(p), 'umer-app-wt');
  git('worktree', 'add', '-q', wt);
  const r = spawnSync(process.execPath, [CLI, 'init', '-y', '--no-skill', '--json', '--dir', wt], { encoding: 'utf8', env: { ...env, PATH: `${env.PATH}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parse(readFileSync(join(wt, '.learn-from-mistakes.yaml'), 'utf8')).sources.gate.path, join(nm, 'state.sqlite'));
});

// doctor after init: every check ok or warn, exit 0; then a missing defect log, a judge on the worker's identity and
// a premium model are 3 fail lines, each with its fix, exit 1; after the fixes, exit 0 again. Login checks run the
// agent's own status command (pi's never refreshes a token) and print no credential text.
test('doctor names each fail with its fix and exits 1 until the fixes are made', () => {
  const { p, lfm, config, env, global } = setup(['claude', 'opencode', 'pi', 'gemini']);
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
  writeFileSync(config, `${yaml}agent: pi\njudge_agent: pi\nagent_config: { pi: { model: claude-opus-5-5 } }\n`);
  const bad = doctor();
  assert.equal(bad.status, 1);
  const fails = bad.out.checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['source log', 'worker model', 'judge model', 'identity']);
  assert.ok(fails.every((c) => c.fix), 'a fail with no fix');
  assert.ok(fails[0].fix.startsWith(`check sources.log.path in ${config}, or create it: touch `), fails[0].fix);
  // each fix names the file the key came from: agent_config.pi from the project file, allow_premium from neither (the global file)
  assert.equal(fails[1].fix, `set agent_config."pi".model in ${config} to a cheap model, or set allow_premium: true in ${global}`);
  assert.equal(readFileSync(join(p, '..', 'pi-argv'), 'utf8'), 'auth check --no-refresh --model claude-opus-5-5\n');
  const text = lfm('doctor');
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^fail identity +the worker \(pi [^)]*\) and the judge \(pi [^)]*\) resolve to the same agent and model.*\n {5}fix: set judge_agent in /m);
  assert.match(text.stderr, /^next: learn-from-mistakes-axi doctor   # again after the 4 fixes above/m);

  writeFileSync(join(p, 'docs', 'defects.md'), '- 2026-10-12 umer: a synthetic defect\n');
  writeFileSync(config, `${yaml}agent: pi\nagent_config: { pi: { model: umer-cheap-1 } }\n`);
  const fixed = doctor();
  assert.equal(fixed.status, 0, fixed.stdout);
  assert.equal(fixed.out.fails, 0);
});

test('doctor fails a worker pinned to a runner that is not offered, and asks to set it to another agent when the judge takes the only other CLI', () => {
  const { lfm, config, keys } = setup(['claude', 'gemini']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: gemini\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.match(fails[0].detail, /^gemini is not offered: /);
  assert.equal(fails[0].fix, `set agent in ${config} to another agent`);
});

test('doctor names a usable runner that does not clash with the other role in a pinned-role fix', () => {
  const { lfm, config, keys } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: gemini\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `set agent in ${config} to codex`); // claude is the auto judge
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
  const r = lfm('init', '-y', '--no-skill', '--agent', 'byokit:nope');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /worker: byokit:nope is not a BYOKit plan route: use one of: byokit:/);
});

test('init refuses a judge on a BYOKit route that is not a plan route, with the --agent and --judge-agent hint and exit 2', () => {
  const { lfm, config } = setup(['claude']);
  const r = lfm('init', '-y', '--no-skill', '--agent', 'claude', '--judge-agent', 'byokit:nope');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /judge: byokit:nope is not a BYOKit plan route: use one of: byokit:/);
  assert.match(r.stderr, /^next: learn-from-mistakes-axi init --agent <agent> --judge-agent byokit:nope/m);
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

test('doctor offers no runner whose premium model allow_premium forbids, so the fix does not make a new fail', () => {
  const { lfm, keys, global } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: gemini\nagent_config: { codex: { model: claude-opus-5-5 } }\n'); // codex would run a premium model; claude is the judge
  const fails = JSON.parse(lfm('doctor', '--json').stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].fix, `install gemini, or set agent_path_override.gemini in ${global}`);
});

test('doctor names the pinned runner\'s own problem, not a premium fix, when that runner is not on PATH', () => {
  const { lfm, keys, env, global } = setup(['claude', 'codex']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: claude\nagent_config: { claude: { model: claude-opus-5-5 } }\n');
  rmSync(join(env.PATH, 'claude'));
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.equal(fails[0].detail, 'claude is not usable: claude is not on PATH');
  assert.equal(fails[0].fix, `install claude, or set agent_path_override.claude in ${global}`);
});

// A worker on a BYOKit route is checked by BYOKit's own sign-in, not as an agent CLI: a route with no sign-in is a fail
// with the sign-in fix, and doctor runs to the end instead of failing on the missing agent CLI row.
test('doctor checks a BYOKit worker route by its sign-in and names the sign-in fix', () => {
  const { lfm, config, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:chatgpt"\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const line = JSON.parse(r.stdout).checks.find((c) => c.label === 'worker login');
  assert.equal(line.level, 'fail');
  assert.match(line.fix, /^sign in to chatgpt through BYOKit .* then: learn-from-mistakes-axi agents --test byokit:chatgpt$/);
});

// A BYOKit worker with no model is checked on the model BYOKit calls (its route default), not the agent CLI table.
test('doctor checks a BYOKit worker with no model on the route default BYOKit calls', async () => {
  const { provider } = await import('@byokit/accounts');
  const { lfm, config, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:chatgpt"\n');
  const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker model');
  assert.deepEqual([line.level, line.detail], ['ok', provider('chatgpt').models.fast]);
});

// A BYOKit route that is not a plan route fails the role itself, with BYOKit's problem and fix; no sign-in line follows.
test('doctor fails a BYOKit worker on a route that is not a plan route, before any sign-in check', () => {
  const { lfm, config, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:nope"\n');
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(r.stdout).checks;
  const role = checks.find((c) => c.label === 'worker');
  assert.equal(role.level, 'fail');
  assert.match(role.detail, /^byokit:nope is not a BYOKit plan route/);
  assert.match(role.fix, /^use one of: byokit:/);
  assert.equal(checks.some((c) => c.label === 'worker login'), false);
});

test('doctor --live prints one fail for a judge on a failed BYOKit route, and no live call for it', () => {
  const { lfm, config, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('judge_agent: "byokit:nope"\n');
  const r = lfm('doctor', '--live', '--json');
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(r.stdout).checks;
  const judge = checks.filter((c) => c.label === 'judge');
  assert.deepEqual(judge.map((c) => c.level), ['fail']);
  assert.match(judge[0].detail, /^byokit:nope is not a BYOKit plan route/);
  assert.equal(checks.some((c) => c.label === 'judge live'), false);
});

// A BYOKit plan-key route with no model in agent_config has no catalogue default, and no agent CLI would pick one for it:
// the model is a fail with the key to set, not an agent-CLI warn, and --live makes no call that would fail a second time.
test('doctor fails a BYOKit worker with no model and no default, names the key to set, and --live adds no second fail', () => {
  const { lfm, keys, global } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:zai-coding-cn"\n');
  const r = lfm('doctor', '--live', '--json');
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(r.stdout).checks;
  const line = checks.find((c) => c.label === 'worker model');
  assert.deepEqual([line.level, line.detail, line.fix], ['fail', 'BYOKit has no default model for zai-coding-cn', `set agent_config."byokit:zai-coding-cn".model in ${global}`]);
  assert.equal(checks.some((c) => c.label === 'worker live'), false);
});

// Two BYOKit roles on one route read one agent_config entry, so they call the same model: the judge would judge its own work.
test('doctor fails two BYOKit roles on one route as one identity', () => {
  const { lfm, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:chatgpt"\njudge_agent: "byokit:chatgpt"\n');
  const clash = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'identity');
  assert.equal(clash.level, 'fail');
  assert.match(clash.detail, /^the worker \(byokit:chatgpt [^)]*\) and the judge \(byokit:chatgpt [^)]*\) resolve to the same agent and model/);
});

// A pi whose auth check exits non-zero: the login file decides. A present auth.json is a warn with the exit code; an
// absent one is a fail with the login fix. The HOME is synthetic, and the auth.json in it is a placeholder.
for (const [authJson, level, detail] of [[true, 'warn', 'pi auth check failed (exit 3); auth.json present'], [false, 'fail', 'pi auth check failed (exit 3); no auth.json']]) {
  test(`doctor checks pi's login file after a failed auth check: ${authJson ? 'present is a warn' : 'absent is a fail with its fix'}`, () => {
    const { lfm, keys, env } = setup(['claude', 'pi']);
    writeFileSync(join(env.PATH, 'pi'), '#!/bin/sh\nif [ "$1" = auth ]; then echo "no session" >&2; exit 3; fi\necho "1.0.0"\n');
    chmodSync(join(env.PATH, 'pi'), 0o755);
    if (authJson) {
      mkdirSync(join(env.HOME, '.pi', 'agent'), { recursive: true });
      writeFileSync(join(env.HOME, '.pi', 'agent', 'auth.json'), '{"placeholder": true}\n');
    }
    assert.equal(lfm('init', '-y', '--no-skill').status, 0);
    keys('agent: pi\njudge_agent: claude\nagent_config: { pi: { model: umer-cheap-1 } }\n');
    const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker login');
    assert.equal(line.level, level);
    assert.equal(line.detail, detail);
    assert.equal(line.fix, level === 'fail' ? 'pi   # then /login' : undefined);
  });
}
