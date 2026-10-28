// End-to-end: the real CLI runs `init` in a throwaway git repo, with fake agent CLIs (PATH holds only them), a throwaway
// HOME (with an empty Claude Code session store) and LFM_HOME, and a synthetic no-mistakes store under NM_HOME that has a row
// for the repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), NM_HOME: nm,
    SIGN_OFF_HOME: join(tmp, 'home'), TMPDIR: tmp, LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: tmp };
  if (chosen) { mkdirSync(env.LFM_HOME); writeFileSync(join(env.LFM_HOME, 'config.yaml'), chosen); }
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  const config = join(p, '.learn-from-mistakes.yaml');
  const keys = (text) => appendFileSync(config, text); // agent keys after the commented ones init wrote
  return { tmp, p, nm, lfm, config, env, keys, global: join(env.LFM_HOME, 'config.yaml') };
}

// The starter causes init writes, each with the session signal its match rule tags.
const STARTER = [['test-failed', 'test_fail'], ['command-failed', 'nonzero_exit'], ['tool-misused', 'tool_error'], ['user-corrected', 'correction']];
const PICK = ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'opencode', '--judge-model', MODELS.opencode];

// The installer path: setup writes the config, the skill and the health answer with no prompt and no stdin, and a
// second run over the same home and project writes nothing (byte for byte). doctor answers without a terminal too.
test('setup is one non-interactive command: the choices as flags, then idempotent, then the doctor exit code', () => {
  const { p, lfm, config, global, env } = setup(['claude', 'opencode']);
  // A logged-in stub for the judge's agent: a fresh HOME holds no credential, and doctor's login line is not this test.
  writeFileSync(join(env.PATH, 'opencode'), '#!/bin/sh\nif [ "$1" = auth ]; then echo "1 credential"; fi\necho "1.0.0"\n');
  chmodSync(join(env.PATH, 'opencode'), 0o755);
  const args = ['setup', '--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'opencode', '--judge-model', MODELS.opencode, '--sessions', 'claude', '--json'];
  const first = lfm(...args); // stdin is a closed pipe: no terminal, nothing to read
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const a = JSON.parse(first.stdout);
  assert.deepEqual([a.ready, a.changed, a.config_status, a.global_status, a.fails], [true, true, 'written', 'written', 0]);
  assert.deepEqual([a.config, a.global], [config, global]);
  assert.deepEqual([a.worker, a.judge], [{ runner: 'claude', model: MODELS.claude }, { runner: 'opencode', model: MODELS.opencode }]);
  const skill = join(env.HOME, '.claude', 'skills', 'lfm-retro', 'SKILL.md');
  assert.ok(existsSync(skill), `no skill at ${skill}`);
  assert.ok(a.skills.length && a.skills.every((f) => existsSync(f)));
  assert.deepEqual(a.checks.filter((c) => c.level === 'fail'), []); // warn-only: ready
  assert.doesNotMatch(first.stderr, /Which agent|model for|agent: $/); // nothing was asked

  const files = [config, global, skill].map((f) => readFileSync(f));
  const second = lfm(...args);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const b = JSON.parse(second.stdout);
  assert.deepEqual([b.ready, b.changed, b.config_status, b.global_status], [true, false, 'already set up', 'kept']);
  assert.deepEqual([config, global, skill].map((f) => readFileSync(f)), files); // byte for byte unchanged
  assert.deepEqual(b.ignored, ['--agent', '--model', '--judge-agent', '--judge-model', '--sessions']);
  assert.doesNotMatch(second.stderr, /Which agent|model for|agent: $/);

  const doc = lfm('doctor', '--json'); // the health command alone: offline, no terminal
  assert.deepEqual([doc.status, JSON.parse(doc.stdout).fails], [0, 0]);

  writeFileSync(config, 'sources:\n  log: { type: markdown-log, path: docs/defects.md }\n'); // no agent chosen
  const unset = lfm('doctor', '--json');
  assert.equal(unset.status, 1, unset.stderr); // a fail line, never a prompt
  const failed = JSON.parse(unset.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(failed.map((c) => c.label), ['worker', 'judge']);
  assert.ok(failed.every((c) => /^ask the user which agent and model to use, then set /.test(c.fix)));

  const bare = lfm('setup', '--agent', 'claude', '--json'); // every choice is required: it asks nothing
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /^error: setup needs --model --judge-agent --judge-model: it asks nothing/m);
});

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
  for (const cmd of [['retro', '--foreground'], ['agents']]) {
    const stop = lfm(...cmd);
    assert.equal(stop.status, 2, `${cmd[0]}: ${stop.stderr}`);
    assert.match(stop.stderr, /^error: ask the user which agent to use: /m);
    assert.equal(stop.stderr.match(/^next: (.*)$/m)[1], save);
  }
  // doctor is the health command: no terminal, so the missing choices are fail lines with their fix, not a stop.
  const doc = lfm('doctor', '--json');
  assert.equal(doc.status, 1, doc.stderr);
  const failed = JSON.parse(doc.stdout).checks.filter((c) => c.level === 'fail');
  assert.deepEqual(failed.map((c) => c.label), ['worker', 'judge']);
  assert.ok(failed.every((c) => /^ask the user which agent and model to use, then set (agent|judge_agent) and its agent_config model in /.test(c.fix)));

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

// doctor after init: every check ok or warn, exit 0; then a missing defect log is one fail line with its fix, exit
// 1, and after the fix exit 0 again. A judge on the worker's agent and a premium model name are the user's choice:
// no fail line. Login checks run the agent's own status command (pi's never refreshes a token) and print no
// credential text.
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

const SKILL = readFileSync(new URL('../skills/lfm-retro/SKILL.md', import.meta.url), 'utf8');
const PICK2 = ['--agent', 'claude', '--model', MODELS.claude, '--judge-agent', 'codex', '--judge-model', MODELS.codex];

test('init installs the skill into each configured agent\'s own skills dir; a second init writes nothing; doctor shows the skill ok', () => {
  const { lfm, config, env } = setup(['claude', 'codex']);
  const out = JSON.parse(lfm('init', '-y', '--json', ...PICK2).stdout);
  assert.equal(out.skills.length, 2);
  for (const root of [join(env.HOME, '.claude', 'skills'), join(env.HOME, '.codex', 'skills')]) {
    const file = join(root, 'lfm-retro', 'SKILL.md');
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
