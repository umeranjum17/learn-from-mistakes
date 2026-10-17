// End-to-end: the real CLI runs `init` in a throwaway git repo, with fake agent CLIs (PATH holds only them), a throwaway
// HOME (with an empty Claude Code session store) and LFM_HOME, and a synthetic no-mistakes store under NM_HOME that has a row
// for the repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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

// The starter causes init writes, each with the session signal its match rule tags.
const STARTER = [['test-failed', 'test_fail'], ['command-failed', 'nonzero_exit'], ['tool-misused', 'tool_error'], ['user-corrected', 'correction']];
const PICK = ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'opencode', '--judge-model', MODELS.opencode];

test('init writes the global agent config and a working project config once: the agents the user chose, the sources found, a git-ignored .lfm', () => {
  const { p, nm, lfm, config, global } = setup(['claude', 'opencode']);
  const r = lfm('init', '-y', '--no-skill', '--json', ...PICK, '--sessions', 'claude');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.status, out.global, out.global_status], ['written', global, 'written']);
  assert.deepEqual([out.worker, out.judge], [{ runner: 'claude', model: MODELS.claude }, { runner: 'opencode', model: MODELS.opencode }]);
  assert.deepEqual([out.gaps, out.missing], [[], []]);
  assert.equal(parse(readFileSync(global, 'utf8')), null); // every key in the global file is commented: it sets no agent
  assert.match(readFileSync(config, 'utf8'), /^# agent: claude /m); // the project file names the keys it may override, commented
  assert.deepEqual(parse(readFileSync(config, 'utf8')), { name: 'umer-app', excerpts: 'on',
    sources: { log: { type: 'markdown-log', path: 'docs/defects.md' }, gate: { type: 'no-mistakes', path: join(nm, 'state.sqlite') },
      sessions: { type: 'sessions', agents: ['claude'] } }, // only the agents the user named
    agent: 'claude', judge_agent: 'opencode', agent_config: { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }, // exactly what was chosen
    causes: Object.fromEntries(STARTER.map(([id, signal]) => [id, { description: parse(readFileSync(config, 'utf8')).causes[id].description, match: { source: 'sessions', signal } }])) });
  assert.deepEqual(out.causes, STARTER.map(([id]) => id));
  assert.equal(readFileSync(join(p, '.lfm', '.gitignore'), 'utf8'), '*\n');
  assert.equal(execFileSync('git', ['-C', p, 'status', '--short'], { encoding: 'utf8' }), '?? .learn-from-mistakes.yaml\n?? docs/\n');
  const text = lfm('init');
  assert.match(text.stdout, /^excerpts on: the worker \(claude\) and the judge \(opencode\) see redacted record excerpts/m);
  assert.doesNotMatch(text.stdout, /\bworkerBin\b|\bjudgeBin\b|\bpid\b/); // the human output names plain words
  for (const file of [global, config]) assert.ok(readFileSync(file, 'utf8').split('\n').every((l) => l.length <= 100), `${file}: a line is over 100 characters`);

  const bytes = readFileSync(config), globalBytes = readFileSync(global);
  const again = lfm('init', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([JSON.parse(again.stdout).status, JSON.parse(again.stdout).global_status], ['already set up', 'kept']);
  assert.ok(['workerBin', 'judgeBin'].every((k) => k in JSON.parse(again.stdout)), 'the --json schema keeps its keys');
  assert.deepEqual(readFileSync(config), bytes);
  assert.deepEqual(readFileSync(global), globalBytes); // never overwritten

  const run = lfm('retro', '--foreground', '--json'); // the written config runs: every detected source is read
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).run.status, 'completed');

  // --reconfigure applies new agent and session flags to the existing config: the roles are replaced, every other key
  // and comment stays. Without it the same flags change nothing, and the ignored line names the flag.
  const applied = ['--agent', 'opencode', '--model', MODELS.opencode, '--judge-agent', 'claude', '--judge-model', 'claude-sonnet-6', '--sessions', 'opencode', '--no-skill'];
  const refused = lfm('init', ...applied);
  assert.equal(refused.status, 0, refused.stderr);
  assert.match(refused.stdout, /^--agent --model --judge-agent --judge-model --sessions not applied: \.learn-from-mistakes\.yaml exists \(edit it to change them, or init --reconfigure to apply --agent --model --judge-agent --judge-model --sessions\)$/m);
  assert.equal(readFileSync(config, 'utf8'), bytes.toString()); // without the flag: nothing changed
  const rc = lfm('init', ...applied, '--reconfigure', '--json');
  assert.equal(rc.status, 0, rc.stderr);
  assert.deepEqual(JSON.parse(rc.stdout).ignored, []);
  const reread = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([reread.agent, reread.judge_agent, reread.agent_config, reread.sources.sessions],
    ['opencode', 'claude', { claude: { model: 'claude-sonnet-6' }, opencode: { model: MODELS.opencode } }, { type: 'sessions', agents: ['opencode'] }]); // the flags replaced those keys
  assert.deepEqual([reread.name, reread.excerpts, Object.keys(reread.causes)], ['umer-app', 'on', STARTER.map(([id]) => id)]); // every other key stays
  assert.match(readFileSync(config, 'utf8'), /^# written by learn-from-mistakes-axi init/m); // its comments stay too
  // the ignored line names --reconfigure only for the flags it applies: --no-excerpts alone keeps the plain text,
  // and when both kinds are ignored, the line says which flags each part covers.
  assert.match(lfm('init', '--no-excerpts').stdout, /^--no-excerpts not applied: \.learn-from-mistakes\.yaml exists \(edit it to change them\)$/m);
  const mixed = lfm('init', '--no-excerpts', '--agent', 'opencode', '--model', MODELS.opencode);
  assert.match(mixed.stdout, /^--agent --model --no-excerpts not applied: \.learn-from-mistakes\.yaml exists \(edit --no-excerpts to change it, or init --reconfigure to apply --agent --model\)$/m);

  writeFileSync(config, 'sources: {}\n'); // an existing config is never rewritten: no starter causes, and its gaps say how to add them
  const gaps = JSON.parse(lfm('init', '-y', '--json').stdout).gaps;
  assert.match(gaps[0], ASK);
  assert.deepEqual(gaps.slice(1), [`sessions: ask the user which agents' sessions to read (local stores: claude), then run learn-from-mistakes-axi init --sessions <agent>,<agent> --dir ${p}   # with the user's answer`,'causes: none in .learn-from-mistakes.yaml, so every label is other: add a causes key with a description per cause',
    'sources: markdown-log found at docs/defects.md, not configured (add it as log)',
    'sources: no-mistakes found at ' + join(nm, 'state.sqlite') + ', not configured (add it as gate)']);
  assert.deepEqual(parse(readFileSync(config, 'utf8')), { sources: {} });
  const own = readFileSync(config, 'utf8');
  assert.deepEqual(JSON.parse(lfm('init', '-y', '--json').stdout).causes, []);
  assert.equal(readFileSync(config, 'utf8'), own);
  rmSync(config);
  mkdirSync(join(p, 'data'));
  copyFileSync(join(p, 'docs', 'defects.md'), join(p, 'data', 'defects.md'));
  rmSync(join(p, 'docs'), { recursive: true });
  writeFileSync(join(p, 'reviews.md'), '- 2026-10-12 umer: a synthetic review finding\n');
  const plain = lfm('init', '--no-excerpts'); // a plain init with no agent set prints what it wrote, then asks the user
  assert.equal(plain.status, 2, plain.stderr);
  assert.match(plain.stdout, /^status: written\n[^]*^causes\[4\]: test-failed,command-failed,tool-misused,user-corrected$/m);
  assert.match(plain.stderr, /^error: ask the user which agent to use: agent and judge_agent are not set/m);
  const { excerpts, sources: { log, reviews } } = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([excerpts, log.path, reviews.path], ['off', 'data/defects.md', 'reviews.md']);
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
  // Not a terminal: the sessions source is asked too, with the local stores as choices, and none is written.
  const sessionsSave = `learn-from-mistakes-axi init --sessions <agent>,<agent> --dir ${p}   # with the user's answer`;
  assert.equal(out.gaps[1], `sessions: ask the user which agents' sessions to read (local stores: claude), then run ${sessionsSave}`);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config, yaml.sources.sessions], [undefined, undefined, undefined, undefined]);
  assert.ok(Object.values(yaml.causes).every((c) => !c.match)); // no sessions source: the starter causes match nothing
  const noSkill = lfm('init', '-y');
  assert.equal(noSkill.status, 0, noSkill.stderr);
  assert.match(noSkill.stdout, /^skills: no configured agent has a skills dir$/m);
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
  assert.deepEqual([JSON.parse(set.stdout).ignored, JSON.parse(set.stdout).gaps.length], [['--agent', '--model'], 1]); // a set key is never rewritten
  assert.equal(lfm('init').stderr.match(/^next: (.*)$/m)[1], sessionsSave);
  assert.match(lfm('init', '--sessions', 'auto').stderr, /^error: --sessions "auto" must list agents by name: claude, codex, opencode, pi, gemini$/m);
  const named = lfm('init', '--sessions', 'claude,pi,gemini', '--json'); // an existing file takes the user's named agents
  assert.deepEqual([named.status, JSON.parse(named.stdout).gaps], [0, []]);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).sources.sessions, { type: 'sessions', agents: ['claude', 'pi', 'gemini'] });
  assert.deepEqual(JSON.parse(lfm('init', '--sessions', 'codex', '--json').stdout).ignored, ['--sessions']); // never rewritten
  writeFileSync(config, readFileSync(config, 'utf8').replace('[ claude, pi, gemini ]', '[ auto ]'));
  const auto = lfm('doctor');
  assert.equal(auto.status, 1, auto.stdout);
  assert.match(auto.stdout, /sources\.sessions\.agents: auto is not a value; ask the user which agents' sessions to read and list them by name, such as agents: \[claude, pi\]/);
  assert.deepEqual(Object.entries(parse(readFileSync(config, 'utf8'))).filter(([k]) => k.includes('agent')),
    [['agent', 'claude'], ['agent_config', { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }], ['judge_agent', 'opencode']]);
});

// A terminal (stdin and stdout are TTYs, here a pseudo-terminal from util-linux script) is asked: a pick list of the
// supported agents, then the model. The answer is saved.
test('in a terminal, init asks for each agent and model and saves the answer', () => {
  const { tmp, p, env, config, lfm } = setup(['claude', 'opencode']);
  // the worker and judge are picked by number; the judge's first model is a bare id, refused and asked again, then typed
  const answers = ['1', '1', MODELS.claude, '3', 'muse-spark-1.3-contributor', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Which agent runs the worker\?\r?\n {2}1\) claude\r?\n {2}2\) codex\r?\n {2}3\) opencode/);
  assert.match(r.stdout, /muse-spark-1\.3-contributor is not a model id \(letters/);
  assert.match(r.stdout, /saved: agent and judge_agent in /);
  assert.ok(r.stdout.indexOf('status: written') < r.stdout.indexOf('Which agent runs the worker'), 'the written report comes before the ask');
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], ['claude', 'opencode', { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }]);
  assert.equal(lfm('agents', '--json').status, 0); // the saved config loads
});

// The agent pick offers the routes BYOKit's own listing reports as ready (past the old fixed three), and the model
// question for a BYOKit route lists the models BYOKit exposes for it; the user still types or picks one by number.
test('in a terminal, the pick lists BYOKit routes and the model question lists the route models', async () => {
  const { tmp, p, env, config } = setup(['claude', 'opencode']);
  const { readyRoutes, routeModels } = await import('../src/runners/byokit.mjs');
  assert.ok((await readyRoutes()).includes('zai-coding-cn'));
  assert.ok((await readyRoutes()).includes('zai:plan_key')); // a ready route with no alias is offered by its full id
  assert.ok((await routeModels('zai:plan_key'))?.includes('glm-4.7')); // the model question works for it too
  const models = await routeModels('opencode-go');
  assert.ok(models?.length > 1);
  // sessions, a typed byokit:<route>, its first listed model by number, then the judge and its typed model
  const answers = ['1', 'byokit:opencode-go', '1', '1', MODELS.claude].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /\) byokit:opencode-go/);
  assert.match(r.stdout, /\) byokit:zai-coding-cn/); // from BYOKit's listing, never in the fixed list
  assert.match(r.stdout, /Models for byokit:opencode-go:/);
  assert.ok(r.stdout.includes(models[0]) && r.stdout.includes(models[1]));
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent], ['byokit:opencode-go', 'claude']);
  assert.equal(yaml.agent_config['byokit:opencode-go'].model, models[0]); // picked by number, never chosen by the tool
});

// With the BYOKit packages missing from the install the pick still offers the agent CLIs, says how to repair it, and never fails.
test('in a terminal where BYOKit cannot load, the pick offers the agent CLIs and says how to repair the install', () => {
  const { tmp, p, env, config } = setup(['claude', 'codex']);
  const loader = new URL('./byokit-missing-loader.mjs', import.meta.url).pathname;
  const answers = ['1', '1', MODELS.claude, '2', MODELS.codex].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} --import ${loader} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, / {2}1\) claude\r?\n {2}2\) codex\r?\n {2}3\) opencode\r?\n {2}4\) pi\r?\n/);
  assert.doesNotMatch(r.stdout, /\) byokit:/);
  assert.match(r.stdout, /\(BYOKit cannot load: npm install -g learn-from-mistakes-axi   # reinstall: the BYOKit packages are its dependencies\)/);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent], ['claude', 'codex']);
});

// The sessions question is asked once: an empty answer (none) is carried into the rerun that saves the roles, so the
// prompt is printed once and no sessions source is written.
test('in a terminal, init asks which sessions to read once, and an empty answer writes no sessions source', () => {
  const { tmp, p, env, config } = setup(['claude', 'opencode']);
  const answers = ['', '1', MODELS.claude, '3', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.match(/Which agents' sessions should the retro read\?/g)?.length, 1);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.equal(yaml.sources?.sessions, undefined);
  assert.deepEqual([yaml.agent, yaml.judge_agent], ['claude', 'opencode']);
});

// No local session store: init still prints the ask line with the save command, and a terminal gets that line, not a
// pick list it has nothing to offer.
test('with no local session store, init still says to ask which agents\' sessions to read', () => {
  const { tmp, p, env, config, lfm } = setup(['claude', 'opencode']);
  rmSync(join(env.HOME, '.claude'), { recursive: true, force: true });
  const save = `learn-from-mistakes-axi init --sessions <agent>,<agent> --dir ${p}   # with the user's answer`;
  const plain = lfm('init', '-y', '--no-skill', '--json');
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(JSON.parse(plain.stdout).gaps.includes(`sessions: ask the user which agents' sessions to read, then run ${save}`), plain.stdout);
  assert.equal(parse(readFileSync(config, 'utf8')).sources?.sessions, undefined);
  const answers = ['1', MODELS.claude, '3', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /Which agents' sessions should the retro read\?/);
  assert.match(r.stdout, /sessions: ask the user which agents' sessions to read, then run learn-from-mistakes-axi init --sessions <agent>,<agent> --dir/);
  assert.equal(parse(readFileSync(config, 'utf8')).sources?.sessions, undefined);
});

// A hand-edited config whose `sources:` key is null takes the sessions source instead of a stack trace.
test('init --sessions writes into a config whose sources key is null', () => {
  const { lfm, config } = setup(['claude', 'opencode'], CHOSEN('claude', 'opencode'));
  writeFileSync(config, 'sources:\n');
  const r = lfm('init', '-y', '--no-skill', '--sessions', 'claude');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Expected YAML collection/);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).sources, { sessions: { type: 'sessions', agents: ['claude'] } });
});

// Ctrl-D at the first pick: nothing is saved, and the printed command that saves the answer keeps the project dir.
test('in a terminal, ending the pick early prints the save command with --dir', () => {
  const { tmp, p, env, config } = setup(['claude', 'opencode']);
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --sessions claude --dir ${p}`, '/dev/null'],
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
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --sessions claude --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /Which agent runs the worker/);
  assert.match(r.stdout, /saved: agent_config\.claude\.model and judge_agent in /);
  assert.equal(readFileSync(global, 'utf8'), 'agent: claude\n');
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], [undefined, 'opencode', { claude: { model: MODELS.claude }, opencode: { model: MODELS.opencode } }]);
});

// A worker and judge already set to one agent with no model: the model is asked once, and both roles run it.
test('in a terminal, a worker and judge set to one agent are asked its model once', () => {
  const { tmp, p, env, config, global } = setup(['claude'], 'agent: claude\njudge_agent: claude\n');
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --sessions claude --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: `${MODELS.claude}\n`, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.match(/model for claude: /g)?.length, 1);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).agent_config, { claude: { model: MODELS.claude } });
  assert.equal(readFileSync(global, 'utf8'), 'agent: claude\njudge_agent: claude\n');
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

// A worker pick equal to the set judge is the user's choice: it is saved, and the judge shares its model.
test('in a terminal, a worker pick equal to the set judge is saved, and the judge shares its model', () => {
  const { tmp, p, env, config } = setup(['claude', 'codex'], 'judge_agent: claude\n');
  const answers = ['1', MODELS.claude].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --sessions claude --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.stdout.match(/model for claude: /g)?.length, 1);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.judge_agent, yaml.agent_config], ['claude', undefined, { claude: { model: MODELS.claude } }]);
});

test('init saves a worker chosen as the set judge\'s agent and model', () => {
  const { lfm, config } = setup(['claude', 'codex'], 'judge_agent: claude\n');
  const r = lfm('init', '--agent', 'claude', '--model', MODELS.claude, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).gaps.filter((g) => /^(worker|judge):/.test(g)), []);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual([yaml.agent, yaml.agent_config.claude.model], ['claude', MODELS.claude]);
});

test('agents lists a configured acp target with the model set for that target', () => {
  const { lfm, config } = setup(['claude'], 'agent: claude\n');
  writeFileSync(config, `agent: acp:umer-target\njudge_agent: claude\nagent_config: { "acp:umer-target": { model: umer-acp-1 }, claude: { model: ${MODELS.claude} } }\n`);
  const row = JSON.parse(lfm('agents', '--json').stdout).agents.find((a) => a.runner === 'acp');
  assert.equal(row.model, 'umer-acp-1');
});

test('a judge on the worker\'s agent and model is no gap in init, and agents passes', () => {
  const { lfm, config } = setup(['claude']);
  writeFileSync(config, `agent: claude\njudge_agent: claude\nagent_config: { claude: { model: ${MODELS.claude} } }\n`);
  const r = lfm('init', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).gaps.filter((g) => /^(worker|judge):/.test(g)), []);
  const agents = lfm('agents', '--json');
  assert.equal(agents.status, 0, agents.stderr);
  const { judge } = JSON.parse(agents.stdout);
  assert.deepEqual([judge.runner, judge.problem || ''], ['claude', '']);
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

test('init refuses two models for one agent, an unknown or unusable agent and a bad model, and writes nothing', () => {
  const { p, lfm, config, env } = setup(['claude', 'opencode', 'gemini']);
  for (const [args, code, error] of [ // one agent in both roles with two models: agent_config holds one model per agent
    [['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'claude', '--judge-model', 'claude-umer-2'], 2, `error: --model ${MODELS.claude} and --judge-model claude-umer-2 both set the model of claude, and agent_config holds one model per agent`],
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
    if (args[5] === 'claude') assert.equal(r.stderr.match(/^next: (.*)$/m)[1], `learn-from-mistakes-axi init --agent claude --model <model> --judge-agent claude --dir ${p}   # ask the user which one model claude runs, or another agent for the judge`);
  }
  writeFileSync(config, `agent: claude\njudge_agent: opencode\nsources: {}\ncauses: {}\nagent_config: { claude: { model: ${MODELS.claude} }, opencode: { model: ${MODELS.opencode} } }\n`); // a set key is never rewritten: the flags that would change it are reported
  const pinned = lfm('init', '--agent', 'opencode', '--judge-agent', 'claude', '--json');
  assert.equal(pinned.status, 0, pinned.stderr);
  const { status, ignored } = JSON.parse(pinned.stdout);
  assert.deepEqual([status, ignored], ['already set up', ['--agent', '--judge-agent']]);
  assert.match(lfm('init', '--no-excerpts').stdout, /^--no-excerpts not applied: \.learn-from-mistakes\.yaml exists \(edit it to change them\)$/m); // --reconfigure does not apply it: not named
  assert.equal(readFileSync(config, 'utf8'), `agent: claude\njudge_agent: opencode\nsources: {}\ncauses: {}\nagent_config: { claude: { model: ${MODELS.claude} }, opencode: { model: ${MODELS.opencode} } }\n`);
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
  // git only, not the host PATH: a host agent's shim run there writes into the test HOME after it is removed
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(env.PATH, 'git'));
  const r = spawnSync(process.execPath, [CLI, 'init', '-y', '--no-skill', '--json', '--dir', wt], { encoding: 'utf8', env });
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
  assert.deepEqual(ok.out.checks.find((c) => c.label === 'sign-off'), { level: 'warn', label: 'sign-off', detail: 'sign-off-axi is not on PATH: questions go in report.txt (plain-text fallback)',
    fix: `npm i -g sign-off-axi   # or set signoff: off in ${config} to keep questions in report.txt` });
  fake('sign-off-axi', ''); // sign-off installs sign-off-axi
  assert.equal(doctor().out.checks.find((c) => c.label === 'sign-off').detail, 'sign-off-axi 1.0.0');
  writeFileSync(join(env.PATH, 'sign-off-axi'), '#!/bin/sh\necho "0.3.3"\n', { mode: 0o755 }); // an older peer takes no finding
  const old = doctor().out.checks.find((c) => c.label === 'sign-off');
  assert.deepEqual([old.level, old.detail], ['warn', `sign-off-axi 0.3.3 cannot post findings (0.3.4 or later): questions go in report.txt (plain-text fallback)`]);
  assert.match(lfm('doctor').stderr, /^next: learn-from-mistakes-axi retro --wait 8m/m);

  const yaml = readFileSync(config, 'utf8');
  rmSync(join(p, 'docs', 'defects.md'));
  writeFileSync(config, `${yaml}agent: pi\njudge_agent: pi\nagent_config: { pi: { model: claude-opus-5-5 } }\n`);
  const bad = doctor();
  assert.equal(bad.status, 1);
  const fails = bad.out.checks.filter((c) => c.level === 'fail');
  // pi in both roles with a premium name is the user's choice: only the missing source fails.
  assert.deepEqual(fails.map((c) => c.label), ['source log']);
  assert.ok(fails[0].fix.startsWith(`check sources.log.path in ${config}, or create it: touch `), fails[0].fix);
  assert.deepEqual(['worker model', 'judge model'].map((l) => bad.out.checks.find((c) => c.label === l)?.detail), ['claude-opus-5-5', 'claude-opus-5-5']);
  assert.equal(readFileSync(join(p, '..', 'pi-argv'), 'utf8'), 'auth check --no-refresh --model claude-opus-5-5\n');
  const text = lfm('doctor');
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^next: learn-from-mistakes-axi doctor   # again after the fix above/m);

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
  assert.match(r.stderr, /^error: worker: byokit:nope is not a BYOKit plan route$/m);
  assert.match(r.stderr, /^next: use one of: byokit:/m);
});

test('init refuses a judge on a BYOKit route that is not a plan route, with the route list as the fix', () => {
  const { lfm, config } = setup(['claude']);
  const r = lfm('init', '-y', '--no-skill', '--agent', 'claude', '--judge-agent', 'byokit:nope');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^error: judge: byokit:nope is not a BYOKit plan route$/m);
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
});

test('doctor warns on each named sessions agent that has no store, and names that agent\'s store variable', () => {
  const { lfm, config, env } = setup(['claude', 'opencode'], CHOSEN('claude', 'opencode'));
  assert.equal(lfm('init', '-y', '--no-skill', '--sessions', 'codex').status, 0);
  const sessions = () => JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'source sessions');
  const fix = (vars) => `${vars}   # if a store is somewhere else, or drop it from sources.sessions.agents in ${config}`;
  assert.deepEqual(sessions(), { level: 'warn', label: 'source sessions', detail: `sessions: no session store at ${join(env.HOME, '.codex', 'state_5.sqlite')}`, fix: fix('export CODEX_HOME=<dir>') });
  writeFileSync(config, readFileSync(config, 'utf8').replace('[ codex ]', '[ claude, codex, pi ]'));
  const listed = sessions();
  assert.equal(listed.level, 'warn');
  assert.match(listed.detail, /; codex store not found at .*state_5\.sqlite \(CODEX_HOME\); pi store not found at .*sessions \(PI_CODING_AGENT_SESSION_DIR\)$/);
  assert.equal(listed.fix, fix('export CODEX_HOME=<dir>; export PI_CODING_AGENT_SESSION_DIR=<dir>'));
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
  assert.equal(role.detail, 'byokit:nope is not a BYOKit plan route'); // the bare problem: the fix is in fix: only
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

// Two BYOKit roles on one route read one agent_config entry, so they call the same model: the user's choice, never a fail.
test('doctor accepts a judge on the worker\'s BYOKit route and model', () => {
  const { lfm, keys } = setup(['claude']);
  assert.equal(lfm('init', '-y', '--no-skill').status, 0);
  keys('agent: "byokit:chatgpt"\njudge_agent: "byokit:chatgpt"\nagent_config: { "byokit:chatgpt": { model: gpt-6-luna } }\n');
  const judge = JSON.parse(lfm('doctor', '--json').stdout).checks.find((c) => c.label === 'judge');
  assert.equal(judge.level, 'ok');
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

test('init names a shared unset model once when the worker and judge are the same agent', () => {
  const { lfm } = setup(['claude']);
  const r = lfm('init', '--agent', 'claude', '--judge-agent', 'claude');
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: ask the user which agent to use: agent_config\.claude\.model is not set in /m);
  assert.doesNotMatch(r.stderr, /agent_config\.claude\.model and agent_config\.claude\.model/);
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

const SKILL = readFileSync(new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url), 'utf8');
const PICK2 = ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'codex', '--judge-model', MODELS.codex];

test('init installs the skill into each configured agent\'s own skills dir; a second init writes nothing; doctor shows the skill ok', () => {
  const { lfm, config, env } = setup(['claude', 'codex']);
  const out = JSON.parse(lfm('init', '-y', '--json', ...PICK2).stdout);
  assert.equal(out.skills.length, 2);
  for (const root of [join(env.HOME, '.claude', 'skills'), join(env.HOME, '.codex', 'skills')]) {
    const file = join(root, 'learn-from-mistakes', 'SKILL.md');
    assert.ok(out.skills.includes(file), `${file} listed`);
    assert.equal(readFileSync(file, 'utf8'), SKILL);
  }
  const bytes = [readFileSync(config), ...out.skills.map((f) => readFileSync(f))];
  const plain = lfm('init');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^skills: nothing new$/m); // the second init writes nothing new and says so
  assert.doesNotMatch(plain.stdout, /skills_|^skills\[/m); // the text output shows the skill lines, not the result fields
  assert.deepEqual(JSON.parse(lfm('init', '-y', '--json').stdout).skills, []);
  assert.deepEqual([readFileSync(config), ...out.skills.map((f) => readFileSync(f))], bytes);
  const [edited] = out.skills;
  writeFileSync(edited, 'a local edit\n');
  const updated = lfm('init');
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(updated.stdout.split('\n').includes(`skill: updated ${edited}`), updated.stdout);
  assert.equal(readFileSync(edited, 'utf8'), SKILL); // init puts the packaged bytes back
  const doctor = JSON.parse(lfm('doctor', '--json').stdout);
  assert.deepEqual(['skill claude', 'skill codex'].map((l) => doctor.checks.find((c) => c.label === l)?.level), ['ok', 'ok']);
});

test('a symlinked skills dir gets one real file; --no-skill writes none; --project-skill writes the project dirs', () => {
  const { p, lfm, env } = setup(['claude', 'opencode']);
  mkdirSync(join(env.HOME, '.agents', 'skills'), { recursive: true });
  symlinkSync(join(env.HOME, '.agents', 'skills'), join(env.HOME, '.claude', 'skills'));
  const PICK_OP = ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'opencode', '--judge-model', MODELS.opencode];
  const out = JSON.parse(lfm('init', '-y', '--json', ...PICK_OP).stdout);
  assert.equal(out.skills.length, 2); // claude through the symlink, and opencode
  assert.equal(new Set(out.skills.map((f) => realpathSync(f))).size, 2);
  assert.equal(realpathSync(join(env.HOME, '.claude', 'skills', 'learn-from-mistakes', 'SKILL.md')),
    realpathSync(join(env.HOME, '.agents', 'skills', 'learn-from-mistakes', 'SKILL.md')));
  const opencodeFile = join(env.HOME, '.config', 'opencode', 'skills', 'learn-from-mistakes', 'SKILL.md');
  const opencodeBytes = readFileSync(opencodeFile);
  rmSync(join(env.HOME, '.agents', 'skills', 'learn-from-mistakes'), { recursive: true, force: true });
  assert.deepEqual(JSON.parse(lfm('init', '-y', '--no-skill', '--json').stdout).skills, []);
  assert.ok(!existsSync(join(env.HOME, '.agents', 'skills', 'learn-from-mistakes', 'SKILL.md')), '--no-skill wrote nothing');
  assert.deepEqual(readFileSync(opencodeFile), opencodeBytes); // and changed nothing
  const proj = JSON.parse(lfm('init', '-y', '--project-skill', '--json').stdout).skills;
  assert.equal(proj.length, 2);
  for (const root of [join(p, '.claude', 'skills'), join(p, '.agents', 'skills')]) {
    const file = join(root, 'learn-from-mistakes', 'SKILL.md');
    assert.ok(proj.includes(file), `${file} listed`);
    assert.equal(readFileSync(file, 'utf8'), SKILL);
  }
  assert.deepEqual(JSON.parse(lfm('init', '-y', '--project-skill', '--json').stdout).skills, []);
});

// The terminal refuses a typed model that starts with a dash, names the rule and asks the model again.
test('in a terminal, a typed model that starts with a dash is refused and asked again', () => {
  const { tmp, p, env, config } = setup(['claude', 'opencode']);
  const answers = ['1', '--yolo', MODELS.claude, '3', MODELS.opencode].join('\n') + '\n';
  const r = spawnSync('/usr/bin/script', ['-qec', `${process.execPath} ${CLI} init --no-skill --sessions claude --dir ${p}`, '/dev/null'],
    { encoding: 'utf8', input: answers, env: { ...env, SHELL: '/bin/sh', TERM: 'dumb' }, cwd: tmp, timeout: 30000 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /--yolo is not a model id \(letters/);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.equal(yaml.agent_config.claude.model, MODELS.claude);
  assert.ok(!JSON.stringify(yaml).includes('--yolo'));
});
