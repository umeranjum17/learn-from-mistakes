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
const MODELS = { claude: 'claude-haiku-5-5', codex: 'gpt-6-luna', opencode: 'opencode-go/muse-spark-1.3-contributor' };
// The agents the user chose, in the global file: the tool never picks one.
const CHOSEN = (agent, judge) => `agent: ${agent}\njudge_agent: ${judge}\nagent_config: ${JSON.stringify(Object.fromEntries(Object.entries(MODELS).map(([a, model]) => [a, { model }])))}\n`;
const ASK = /^agents: ask the user which agent and model to use, then run learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model>/;

function setup(agents, chosen) {
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
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), NM_HOME: nm };
  if (chosen) { mkdirSync(env.LFM_HOME); writeFileSync(join(env.LFM_HOME, 'config.yaml'), chosen); }
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  const config = join(p, '.learn-from-mistakes.yaml');
  const keys = (text) => appendFileSync(config, text); // agent keys after the commented ones init wrote
  return { tmp, p, nm, lfm, config, env, keys, global: join(env.LFM_HOME, 'config.yaml') };
}

const PICK = ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'opencode', '--judge-model', MODELS.opencode];

test('init writes the global agent config and a working project config once: the agents the user chose, the sources found, a git-ignored .lfm', () => {
  const { p, nm, lfm, config, global } = setup(['claude', 'opencode']);
  const r = lfm('init', '-y', '--no-skill', '--json', ...PICK);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.status, out.global, out.global_status], ['written', global, 'written']);
  assert.deepEqual([out.worker, out.judge], [{ runner: 'claude', model: MODELS.claude }, { runner: 'opencode', model: MODELS.opencode }]);
  assert.deepEqual([out.gaps, out.missing], [[], []]);
  assert.equal(parse(readFileSync(global, 'utf8')), null); // every key in the global file is commented: it sets no agent
  assert.match(readFileSync(config, 'utf8'), /^# agent: claude /m); // the project file names the keys it may override, commented
  assert.deepEqual(parse(readFileSync(config, 'utf8')), { name: 'umer-app', excerpts: 'on',
    sources: { log: { type: 'markdown-log', path: 'docs/defects.md' }, gate: { type: 'no-mistakes', path: join(nm, 'state.sqlite') },
      sessions: { type: 'sessions', agents: ['auto'] } },
    agent: 'claude', judge_agent: 'opencode', agent_config: { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } } }); // exactly what was chosen
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
  const gaps = JSON.parse(lfm('init', '-y', '--json').stdout).gaps;
  assert.match(gaps[0], ASK);
  assert.deepEqual(gaps.slice(1), ['sources: markdown-log found at docs/defects.md, not configured (add it as log)',
    'sources: no-mistakes found at ' + join(nm, 'state.sqlite') + ', not configured (add it as gate)',
    'sources: sessions found, not configured (add it as sessions)']);
  assert.equal(readFileSync(config, 'utf8'), 'sources: {}\n');
  rmSync(config);
  const plain = lfm('init', '--no-excerpts'); // a plain init with no agent set writes the files, then asks the user
  assert.equal(plain.status, 2, plain.stderr);
  assert.match(plain.stderr, /^error: ask the user which agent to use: agent and judge_agent are not set/m);
  assert.equal(parse(readFileSync(config, 'utf8')).excerpts, 'off');
});

test('with no agent chosen, init writes none and says to ask the user; a run and doctor stop with the same ask', () => {
  const { p, lfm, config } = setup(['claude', 'opencode', 'codex']);
  const r = lfm('init', '-y', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.missing, ['agent', 'judge_agent']);
  assert.match(out.gaps[0], ASK);
  const save = `learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir ${p}   # with the user's answer`;
  assert.equal(r.stderr.match(/^next: (.*)$/m)[1], save);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], [undefined, undefined, undefined]);
  for (const cmd of [['retro', '--foreground'], ['doctor'], ['agents']]) {
    const stop = lfm(...cmd);
    assert.equal(stop.status, 2, `${cmd[0]}: ${stop.stderr}`);
    assert.match(stop.stderr, /^error: ask the user which agent to use: /m);
    assert.equal(stop.stderr.match(/^next: (.*)$/m)[1], save);
  }

  const worker = lfm('init', '-y', '--agent', 'claude', '--model', MODELS.claude, '--json'); // an existing file takes an unset key
  assert.equal(worker.status, 0, worker.stderr);
  assert.deepEqual([JSON.parse(worker.stdout).missing, JSON.parse(worker.stdout).ignored], [['judge_agent'], []]);
  assert.equal(worker.stderr.match(/^next: (.*)$/m)[1], `learn-from-mistakes-axi init --judge-agent <agent> --judge-model <model> --dir ${p}   # with the user's answer`);
  const plainWorker = lfm('init', '--agent', 'codex', '--model', MODELS.codex); // not -y: the unset judge is still asked, after the write
  assert.equal(plainWorker.status, 2, plainWorker.stderr);
  assert.equal(plainWorker.stderr.match(/^next: (.*)$/m)[1], `learn-from-mistakes-axi init --judge-agent <agent> --judge-model <model> --dir ${p}   # with the user's answer`);
  assert.equal(parse(readFileSync(config, 'utf8')).agent, 'claude'); // a set key is never rewritten
  const set = lfm('init', '--agent', 'codex', '--model', MODELS.codex, '--judge-agent', 'opencode', '--judge-model', MODELS.opencode, '--json');
  assert.deepEqual([JSON.parse(set.stdout).ignored, JSON.parse(set.stdout).gaps], [['--agent', '--model'], []]); // a set key is never rewritten
  assert.deepEqual(Object.entries(parse(readFileSync(config, 'utf8'))).filter(([k]) => k.includes('agent')),
    [['agent', 'claude'], ['agent_config', { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }], ['judge_agent', 'opencode']]);
});

// A terminal (stdin and stdout are TTYs, here a pseudo-terminal from util-linux script) is asked: a pick list of the
// supported agents, then the model; a judge on the worker's agent is asked again. The answer is saved.
test('in a terminal, init asks for each agent and model and saves the answer', () => {
  const { tmp, p, env, config, lfm } = setup(['claude', 'opencode']);
  // the worker and judge are picked by number; the judge is claude first, refused as the worker's agent; its first model is a bare id, refused and asked again, then typed
  const answers = ['1', MODELS.claude, '1', '3', 'muse-spark-1.3-contributor', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Which agent runs the worker \(agent\)\?\r?\n {2}1\) claude\r?\n {2}2\) codex\r?\n {2}3\) opencode/);
  assert.match(r.stdout, /the judge must be another agent than the worker \(claude\)/);
  assert.match(r.stdout, /muse-spark-1\.3-contributor is not a model id \(letters/);
  assert.match(r.stdout, /saved: agent and judge_agent in /);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], ['claude', 'opencode', { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }]);
  assert.equal(lfm('agents', '--json').status, 0); // the saved config loads
});

// Ctrl-D at the first pick: nothing is saved, and the printed command that saves the answer keeps the project dir.
test('in a terminal, ending the pick early prints the save command with --dir', () => {
  const { tmp, p, env, config } = setup(['claude', 'opencode']);
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: '\x04', env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /no answer given: agent and judge_agent not saved/);
  assert.match(r.stdout, new RegExp(`next: learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir ${p}   # with the user's answer`));
  assert.equal(parse(readFileSync(config, 'utf8')).agent, undefined);
});

// The global file names the worker's agent; the terminal is asked only its model, and the agent key is not copied into the project.
test('in a terminal, a worker agent set globally is asked only its model, and the judge is asked both', () => {
  const { tmp, p, env, config, global } = setup(['claude', 'opencode'], 'agent: claude\n');
  const answers = [MODELS.claude, '3', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /Which agent runs the worker/);
  assert.match(r.stdout, /saved: agent_config\.claude\.model and judge_agent in /);
  assert.equal(readFileSync(global, 'utf8'), 'agent: claude\n');
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], [undefined, 'opencode', { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }]);
});

// Review-6: on an existing project file the agent flags are judged against that file, so a global agent never blocks a
// project override; the global file is left as it was.
test('an existing project file takes --agent and --model even when the global file sets the agent', () => {
  const { p, lfm, config, global } = setup(['claude', 'opencode'], `agent: claude\nagent_config: { claude: { model: ${MODELS.claude} } }\n`);
  writeFileSync(config, 'sources: {}\n');
  const globalBytes = readFileSync(global);
  const r = lfm('init', '-y', '--json', '--agent', 'opencode', '--model', MODELS.opencode);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).ignored, []);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.agent_config], ['opencode', { opencode: { model: MODELS.opencode } }]);
  assert.deepEqual(readFileSync(global), globalBytes);
  const again = JSON.parse(lfm('init', '-y', '--json', '--agent', 'claude', '--model', MODELS.claude).stdout);
  assert.deepEqual(again.ignored, ['--agent', '--model']); // a key the project file already sets is reported, not rewritten
  assert.equal(parse(readFileSync(config, 'utf8')).agent, 'opencode');
});

// Not a terminal: init, retro, doctor and agents each stop with the ask line that names the model still to set.
test('with an agent set but no model, init, retro, doctor and agents stop with the ask that names agent_config.<agent>.model', () => {
  const { p, lfm } = setup(['claude', 'opencode'], 'agent: claude\njudge_agent: opencode\n');
  const ask = /^error: ask the user which agent to use: agent_config\.claude\.model and agent_config\.opencode\.model are not set in \S+\.learn-from-mistakes\.yaml, and the tool never picks one/m;
  for (const cmd of [['init'], ['retro', '--foreground'], ['doctor'], ['agents']]) {
    const stop = lfm(...cmd);
    assert.equal(stop.status, 2, `${cmd[0]}: ${stop.stderr}`);
    assert.match(stop.stderr, ask);
    assert.equal(stop.stderr.match(/^next: (.*)$/m)[1], `learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir ${p}   # with the user's answer`);
  }
});

// Review-7: a flag never replaces a model the project file already sets, even when the agent comes from the global file.
test('init --model keeps the model the project file sets for that agent, and lists --model as ignored', () => {
  const { p, lfm, config } = setup(['claude', 'opencode'], 'agent: claude\n');
  writeFileSync(config, 'sources: {}\nagent_config: { claude: { model: umer-cheap-1 } }\n');
  const r = lfm('init', '-y', '--json', '--agent', 'claude', '--model', 'umer-new');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).ignored, ['--model']);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).agent_config, { claude: { model: 'umer-cheap-1' } });
});

// The worker is checked against a judge that is already set, so a terminal pick never makes both roles one agent.
test('in a terminal, a worker pick equal to the set judge is refused and asked again', () => {
  const { tmp, p, env, config } = setup(['claude', 'codex'], 'judge_agent: claude\n');
  const answers = ['1', '2', MODELS.codex, MODELS.claude].join('\n') + '\n'; // claude refused as the worker; codex, its model, then claude's model
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /the worker must be another agent than the judge \(claude\)/);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], ['codex', undefined, { codex: { model: MODELS.codex }, claude: { model: MODELS.claude } }]);
});

test('init refuses a worker chosen as the set judge\'s agent and model, and writes nothing', () => {
  const { p, lfm, config } = setup(['claude', 'codex'], 'judge_agent: claude\n');
  const r = lfm('init', '--agent', 'claude', '--model', MODELS.claude);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: judge: the judge resolves to the worker's agent and model, so it would judge its own work$/m);
  assert.equal(existsSync(config), false);
});

test('a premium model fix names the file that sets the model, not the file that sets another key of its agent', () => {
  const { lfm, config, global } = setup(['pi', 'claude'], 'agent_config: { pi: { model: claude-opus-5-5 } }\n');
  writeFileSync(config, `agent: pi\njudge_agent: claude\nagent_config: { pi: { effort: low }, claude: { model: ${MODELS.claude} } }\n`);
  const fix = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker model').fix;
  assert.equal(fix, `ask the user which agent and model to use, then set agent and its agent_config model in ${global}; the run never picks one, or set allow_premium: true in ${global}`);
});

test('agents lists a configured acp target with the model set for that target', () => {
  const { lfm, config } = setup(['claude'], 'agent: claude\n');
  writeFileSync(config, `agent: acp:umer-target\njudge_agent: claude\nagent_config: { "acp:umer-target": { model: umer-acp-1 }, claude: { model: ${MODELS.claude} } }\n`);
  const row = JSON.parse(lfm('agents', '--json').stdout).agents.find((a) => a.runner === 'acp');
  assert.equal(row.model, 'umer-acp-1');
});

test('a judge on the worker\'s agent and model is reported by init and fails agents, never a silent fallback', () => {
  const { lfm, config } = setup(['claude']);
  writeFileSync(config, `agent: claude\njudge_agent: claude\nagent_config: { claude: { model: ${MODELS.claude} } }\n`);
  const r = lfm('init', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).gaps[0], 'judge: the judge resolves to the worker\'s agent and model, so it would judge its own work');
  assert.equal(r.stderr.match(/^next: (.*)$/m)[1], `ask the user which agent and model to use, then set judge_agent and its agent_config model in ${config}; the run never picks one`);
  const agents = lfm('agents'); // the clash fails every later check of the config
  assert.equal(agents.status, 1);
  assert.match(agents.stderr, /^problem: judge: the judge resolves to the worker's agent/m);
});

test('an empty or relative PATH entry never runs an agent CLI from the project dir', () => {
  const { p, env, config } = setup([]);
  writeFileSync(join(p, 'claude'), '#!/bin/sh\necho ran > ran.txt\necho "1.0.0"\n');
  writeFileSync(join(p, 'git'), '#!/bin/sh\necho ran > ran-git.txt\n');
  chmodSync(join(p, 'claude'), 0o755);
  chmodSync(join(p, 'git'), 0o755);
  for (const PATH of [`${env.PATH}:`, `.:${env.PATH}`]) {
    const r = spawnSync(process.execPath, [CLI, 'init', '--agent', 'claude', '--model', MODELS.claude, '--dir', p, '--json'], { encoding: 'utf8', cwd: p, env: { ...env, PATH } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^error: worker: claude is not usable: claude is not on PATH/m);
    assert.ok(!existsSync(join(p, 'ran.txt')), `the project-dir claude ran with PATH ${PATH}`);
    assert.ok(!existsSync(join(p, 'ran-git.txt')), `the project-dir git ran with PATH ${PATH}`);
    assert.ok(!existsSync(config));
  }
});

test('an existing config whose agent is not installed says to install it or choose another', () => {
  const { lfm, config } = setup([]);
  writeFileSync(config, `agent: claude\njudge_agent: codex\nsources: {}\nagent_config: { claude: { model: ${MODELS.claude} }, codex: { model: ${MODELS.codex} } }\n`);
  const r = lfm('init');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.match(/^next: (.*)$/m)[1], `install claude, or ask the user which agent and model to use, then set agent and its agent_config model in ${config}; the run never picks one`);
});

test('an unusable judge is not named as seeing excerpts', () => {
  const { lfm, config } = setup(['claude']);
  writeFileSync(config, `agent: claude\njudge_agent: codex\nagent_config: { claude: { model: ${MODELS.claude} }, codex: { model: ${MODELS.codex} } }\n`);
  const r = lfm('init');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^excerpts on: the worker \(claude\) and the judge \(codex, not usable\) see redacted record excerpts/m);
});

test('init refuses a judge on the worker\'s identity, an unknown or unusable agent and a bad model, and writes nothing', () => {
  const { lfm, config, env } = setup(['claude', 'opencode', 'gemini']);
  for (const [args, code, error] of [
    [['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'claude', '--judge-model', 'claude-umer-2'], 2, 'error: judge: the judge resolves to the worker\'s agent and model, so it would judge its own work'],
    [['--agent', 'umer'], 2, 'error: --agent "umer" must be an agent: claude, codex, opencode, pi, gemini, acp:<target> or byokit:<route>'],
    [['--model', MODELS.claude], 2, 'error: --model needs --agent'],
    [['--agent', 'opencode', '--model', 'muse'], 2, 'error: --model "muse" must be a model id (letters, digits and . _ / : @ + -, not starting with -), and <provider>/<model> for opencode'],
    [['--judge-agent', 'codex', '--judge-model', MODELS.codex], 1, 'error: judge: codex is not usable: codex is not on PATH'],
    [['--judge-agent', 'gemini'], 1, 'error: judge: gemini is not offered: its read-only plan mode is not yet confirmed in headless mode (agents --test gemini runs the write test)'],
  ]) {
    const r = lfm('init', ...args);
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.stderr.split('\n')[0], error);
    assert.match(r.stderr, /^next: /m);
    assert.ok(!existsSync(config), `${args.join(' ')} wrote a config`);
    assert.ok(!existsSync(join(env.LFM_HOME, 'config.yaml')), `${args.join(' ')} wrote the global config`);
  }
  writeFileSync(config, `agent: claude\njudge_agent: opencode\nsources: {}\nagent_config: { claude: { model: ${MODELS.claude} }, opencode: { model: ${MODELS.opencode} } }\n`); // a set key is never rewritten: the flags that would change it are reported
  const pinned = lfm('init', '--agent', 'opencode', '--judge-agent', 'claude', '--json');
  assert.equal(pinned.status, 0, pinned.stderr);
  const { status, ignored } = JSON.parse(pinned.stdout);
  assert.deepEqual([status, ignored], ['already set up', ['--agent', '--judge-agent']]);
  assert.match(lfm('init', '--no-excerpts').stdout, /^--no-excerpts not applied: \.learn-from-mistakes\.yaml exists \(edit it to change them\)$/m);
  assert.equal(readFileSync(config, 'utf8'), `agent: claude\njudge_agent: opencode\nsources: {}\nagent_config: { claude: { model: ${MODELS.claude} }, opencode: { model: ${MODELS.opencode} } }\n`);
  const missing = spawnSync(process.execPath, [CLI, 'init', '--dir', join(config, 'nope')], { encoding: 'utf8', env: { PATH: '' } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^error: .*nope: not a directory\nnext: /);
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
  const { p, lfm, config, env, global } = setup(['claude', 'opencode', 'pi', 'gemini'], CHOSEN('claude', 'opencode'));
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
  assert.deepEqual(['config', 'state', 'source log', 'source gate', 'worker', 'worker login', 'judge login'].map((l) => level(ok.out, l)), Array(7).fill('ok'));
  assert.equal(ok.out.checks.find((c) => c.label === 'judge login').detail, 'opencode auth list: logged in');
  assert.deepEqual(['skill claude', 'sign-off'].map((l) => level(ok.out, l)), ['warn', 'warn']);
  assert.match(lfm('doctor').stderr, /^next: learn-from-mistakes-axi retro --wait 8m/m);

  const yaml = readFileSync(config, 'utf8');
  rmSync(join(p, 'docs', 'defects.md'));
  writeFileSync(config, `${yaml}agent: pi\njudge_agent: pi\nagent_config: { pi: { model: claude-opus-5-5 } }\n`);
  const bad = doctor();
  assert.equal(bad.status, 1);
  const fails = bad.out.checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['source log', 'worker model', 'judge']);
  assert.ok(fails.every((c) => c.fix), 'a fail with no fix');
  assert.ok(fails[0].fix.startsWith(`check sources.log.path in ${config}, or create it: touch `), fails[0].fix);
  // each fix names the file the key came from: agent_config.pi from the project file, allow_premium from neither (the global file)
  assert.equal(fails[1].fix, `ask the user which agent and model to use, then set agent and its agent_config model in ${config}; the run never picks one, or set allow_premium: true in ${global}`);
  assert.equal(readFileSync(join(p, '..', 'pi-argv'), 'utf8'), 'auth check --no-refresh --model claude-opus-5-5\n');
  const text = lfm('doctor');
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^fail judge +the judge resolves to the worker's agent and model, so it would judge its own work\n {5}fix: ask the user which agent and model to use, then set judge_agent and its agent_config model in /m);
  assert.match(text.stderr, /^next: learn-from-mistakes-axi doctor   # again after the 3 fixes above/m);

  writeFileSync(join(p, 'docs', 'defects.md'), '- 2026-10-12 umer: a synthetic defect\n');
  writeFileSync(config, `${yaml}agent: pi\nagent_config: { pi: { model: umer-cheap-1 } }\n`);
  const fixed = doctor();
  assert.equal(fixed.status, 0, fixed.stdout);
  assert.equal(fixed.out.fails, 0);
});

test('doctor fails a worker set to a runner that is not offered, and asks for another agent the user chooses', () => {
  const { lfm, config, keys } = setup(['claude', 'gemini']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys(`agent: gemini\njudge_agent: claude\nagent_config: { claude: { model: ${MODELS.claude} }, gemini: { model: umer-gem-1 } }\n`);
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const fails = JSON.parse(r.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(fails.map((c) => c.label), ['worker']);
  assert.match(fails[0].detail, /^gemini is not offered: /);
  assert.equal(fails[0].fix, `ask the user which agent and model to use, then set agent and its agent_config model in ${config}; the run never picks one`);
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

test('init refuses a judge on a BYOKit route that is not a plan route, with the route list as the fix', () => {
  const { lfm, config } = setup(['claude']);
  const r = lfm('init', '-y', '--no-skill', '--agent', 'claude', '--judge-agent', 'byokit:nope');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /judge: byokit:nope is not a BYOKit plan route: use one of: byokit:/);
  assert.match(r.stderr, /^next: use one of: byokit:chatgpt, /m);
  assert.equal(existsSync(config), false);
});

test('doctor run from another directory names the full project file in each fix', () => {
  const { p, lfm, config, env } = setup(['claude', 'opencode'], CHOSEN('claude', 'opencode'));
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
  const { lfm, config, env } = setup(['claude', 'opencode'], CHOSEN('claude', 'opencode'));
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  const yaml = readFileSync(config, 'utf8');
  writeFileSync(config, yaml.replace(/(sessions:[\s\S]*?agents:)\s*(\[[^\]]*\]|(\n\s+- .*)+)/, '$1 [codex]'));
  const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'source sessions');
  assert.equal(line.level, 'warn');
  assert.equal(line.detail, `sessions: no session store at ${join(env.HOME, '.codex', 'state_5.sqlite')}`);
  assert.equal(line.fix, `export CODEX_HOME=<dir>   # if a store is somewhere else, or drop it from sources.sessions.agents in ${config}`);
});

test('doctor names an absent store of an auto agent as information, and warns on one a config lists', () => {
  const { lfm, config, env } = setup(['claude', 'opencode'], CHOSEN('claude', 'opencode'));
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

test('doctor names the pinned runner\'s own problem, not a premium fix, when that runner is not on PATH', () => {
  const { lfm, keys, env, global } = setup(['claude', 'codex'], CHOSEN('claude', 'codex'));
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
  keys(`agent: "byokit:chatgpt"\njudge_agent: claude\nagent_config: { "byokit:chatgpt": { model: gpt-6-luna }, claude: { model: ${MODELS.claude} } }\n`);
  const r = lfm('doctor', '--json');
  assert.equal(r.status, 1, r.stderr);
  const line = JSON.parse(r.stdout).checks.find((c) => c.label === 'worker login');
  assert.equal(line.level, 'fail');
  assert.match(line.fix, /^sign in to chatgpt through BYOKit .* then: learn-from-mistakes-axi agents --test byokit:chatgpt$/);
});

// A BYOKit route that is not a plan route fails the role itself, with BYOKit's problem and fix; no sign-in line follows.
test('doctor fails a BYOKit worker on a route that is not a plan route, before any sign-in check', () => {
  const { lfm, config, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys(`agent: "byokit:nope"\njudge_agent: claude\nagent_config: { "byokit:nope": { model: gpt-6-luna }, claude: { model: ${MODELS.claude} } }\n`);
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
  keys(`agent: claude\njudge_agent: "byokit:nope"\nagent_config: { claude: { model: ${MODELS.claude} }, "byokit:nope": { model: gpt-6-luna } }\n`);
  const r = lfm('doctor', '--live', '--json');
  assert.equal(r.status, 1, r.stderr);
  const checks = JSON.parse(r.stdout).checks;
  const judge = checks.filter((c) => c.label === 'judge');
  assert.deepEqual(judge.map((c) => c.level), ['fail']);
  assert.match(judge[0].detail, /^byokit:nope is not a BYOKit plan route/);
  assert.equal(checks.some((c) => c.label === 'judge live'), false);
});

// A BYOKit route with no model in agent_config has none to call, and the tool never picks one: the model is a fail
// with the key to set, not an agent-CLI warn, and --live makes no call that would fail a second time.
test('doctor asks for the model of a BYOKit worker that has none, and makes no call', () => {
  const { lfm, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys(`agent: "byokit:zai-coding-cn"\njudge_agent: claude\nagent_config: { claude: { model: ${MODELS.claude} } }\n`);
  const r = lfm('doctor', '--live', '--json');
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^error: ask the user which agent to use: agent_config\.byokit:zai-coding-cn\.model is not set in /m);
});

// Two BYOKit roles on one route read one agent_config entry, so they call the same model: the judge would judge its own work.
test('doctor fails a judge that resolves to the worker\'s BYOKit route and model', () => {
  const { lfm, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:chatgpt"\njudge_agent: "byokit:chatgpt"\nagent_config: { "byokit:chatgpt": { model: gpt-6-luna } }\n');
  const clash = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'judge');
  assert.equal(clash.level, 'fail');
  assert.equal(clash.detail, 'the judge resolves to the worker\'s agent and model, so it would judge its own work');
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
    keys(`agent: pi\njudge_agent: claude\nagent_config: { pi: { model: umer-cheap-1 }, claude: { model: ${MODELS.claude} } }\n`);
    const line = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'worker login');
    assert.equal(line.level, level);
    assert.equal(line.detail, detail);
    assert.equal(line.fix, level === 'fail' ? 'pi   # then /login' : undefined);
  });
}

// A project config whose agent_config is present but null takes the agent and model that init saves, and the saved config loads.
test('init saves into a project config whose agent_config is null, and the result loads', () => {
  const { lfm, config } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  appendFileSync(config, 'agent_config:\n');
  const r = lfm('init', '-y', '--no-skill', '--agent', 'claude', '--model', MODELS.claude);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Expected YAML|TypeError/);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).agent_config, { claude: { model: MODELS.claude } });
  assert.equal(lfm('init', '-y', '--no-skill').status, 0, 'the saved config loads');
});

// The judge's model is not set, so there is no identity to clash on: init reports the judge model as unset.
test('init does not refuse a judge with no model as a clash, and asks for its model', () => {
  const { lfm } = setup(['claude', 'codex'], 'judge_agent: codex\n');
  const r = lfm('init', '--agent', 'claude', '--model', MODELS.claude);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: ask the user which agent to use: agent_config\.codex\.model is not set in /m);
  assert.doesNotMatch(r.stderr, /would judge its own work/);
});

test('init refuses a model that starts with a dash, at --model and --judge-model, and writes nothing', () => {
  const { lfm, config, env } = setup(['claude', 'opencode']);
  for (const args of [['--agent', 'claude', '--model', '--yolo'], ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'opencode', '--judge-model', '-x']]) {
    const r = lfm('init', ...args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^error: --(judge-)?model .* must be a model id \(letters/m);
    assert.match(r.stderr, /^next: /m);
    assert.ok(!existsSync(config), `${args.join(' ')} wrote a config`);
    assert.ok(!existsSync(join(env.LFM_HOME, 'config.yaml')), `${args.join(' ')} wrote the global config`);
  }
});

// The terminal refuses a typed model that starts with a dash, names the rule and asks the model again.
test('in a terminal, a typed model that starts with a dash is refused and asked again', () => {
  const { tmp, p, env, config } = setup(['claude', 'opencode']);
  const answers = ['1', '--yolo', MODELS.claude, '3', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /--yolo is not a model id \(letters/);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.equal(yaml.agent_config.claude.model, MODELS.claude);
  assert.ok(!JSON.stringify(yaml).includes('--yolo'));
});
