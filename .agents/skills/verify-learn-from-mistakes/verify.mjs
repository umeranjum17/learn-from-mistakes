#!/usr/bin/env node
// Public CLI proof; the existing e2e journeys own behavioral assertions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parse, stringify } from 'yaml';

const repo = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const raw = process.argv.slice(2);
const packageProof = raw.includes('--package');
const [destination, mode, sourceDir, labelsArg, proposalsArg, ...extra] = raw.filter((a) => a !== '--package');
assert(destination && isAbsolute(destination), 'Provide an absolute private evidence directory');
assert(!extra.length && (!mode || (mode === '--private' && sourceDir && labelsArg && proposalsArg)),
  'usage: node verify.mjs /absolute/evidence [--private /project /labels.jsonl /proposals.jsonl] [--package]');
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
// Resolve existing ancestors too: a symlinked output parent must not redirect into the repo.
function canonical(path) {
  path = resolve(path);
  return existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}
const evidence = canonical(destination);
assert(!inside(repo, evidence) && !inside(evidence, repo), 'Evidence must be outside, and not contain, the checkout');
assert(!existsSync(evidence) || (statSync(evidence).isDirectory() && readdirSync(evidence).length === 0), 'Evidence must be new or empty; never overwrite a prior proof');
const project = realpathSync(mode ? sourceDir : join(repo, 'examples'));
const configFile = join(project, '.learn-from-mistakes.yaml');
const config = parse(readFileSync(configFile, 'utf8'));
const inputs = [configFile];
const sources = Object.entries(config.sources).map(([id, s], i) => {
  assert(['markdown-log', 'no-mistakes'].includes(s.type), `Unsupported source ${id}`);
  const path = realpathSync(resolve(project, s.path.replace(/^~(?=\/|$)/, homedir())));
  if (s.type === 'no-mistakes') for (const suffix of ['-wal', '-shm', '-journal'])
    assert(!existsSync(path + suffix), 'Use a quiescent private SQLite snapshot without sidecars');
  inputs.push(path);
  return { id, type: s.type, path, copy: `source-${i}${s.type === 'no-mistakes' ? '.sqlite' : '.md'}` };
});
const labels = realpathSync(mode ? labelsArg : join(project, 'labels.jsonl'));
const proposals = realpathSync(mode ? proposalsArg : join(project, 'proposals.jsonl'));
inputs.push(labels, proposals);
for (const input of inputs) {
  assert(statSync(input).isFile(), `Not a regular input: ${input}`);
  assert(!inside(dirname(input), evidence) && !inside(evidence, input), 'Evidence must not overlap any input directory');
}
const hashes = () => inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const before = hashes();
mkdirSync(evidence, { recursive: true, mode: 0o700 });
chmodSync(evidence, 0o700);
const save = (name, value) => writeFileSync(join(evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
const scratch = join(evidence, 'scratch');
mkdirSync(scratch, { mode: 0o700 });
for (const dir of ['home', 'tmp', 'xdg', 'runtime', 'project']) mkdirSync(join(scratch, dir));
const env = { ...process.env, HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'),
  XDG_CONFIG_HOME: join(scratch, 'xdg'), XDG_CACHE_HOME: join(scratch, 'xdg'), XDG_DATA_HOME: join(scratch, 'xdg'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  npm_config_cache: join(scratch, 'npm-cache'), GIT_CEILING_DIRECTORIES: realpathSync(scratch) }; // the staged project is no part of a repo above it
delete env.LFM_CLI; // only packed-npm-test points the journeys at another bin
delete env.LFM_HOME; // no global config: the CLI keeps state in the staged project's own .lfm/
delete env.CLAUDE_CONFIG_DIR; // the sessions drive reads only the synthetic stores in the scratch HOME and XDG dir
delete env.CODEX_HOME;
const commands = [];
function run(name, command, args, expected = 0, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8' });
  save(`${name}.stdout`, result.stdout ?? '');
  save(`${name}.stderr`, result.stderr ?? '');
  commands.push({ name, command, args, env: extraEnv, cwd: repo, status: result.status, error: result.error?.message });
  save('commands.json', commands);
  assert.equal(result.status, expected, `${name}: inspect private stderr/stdout logs`);
}
save('inputs.before.json', before);
save('identity.json', { repo, head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout,
  node: process.version, mode: mode ? 'private opt-in' : 'synthetic', inputs: before, sources, labels, proposals,
  candidate: ['bin/learn-from-mistakes-axi.mjs', 'src/config.mjs', 'src/metrics.mjs', 'src/followup.mjs', 'src/init.mjs', 'src/doctor.mjs', 'src/sources/markdown-log.mjs', 'src/sources/no-mistakes.mjs', 'src/run.mjs', 'src/store.mjs',
    'src/runners/index.mjs', 'src/runners/byokit.mjs', 'src/runners/claude.mjs', 'src/runners/codex.mjs', 'src/runners/opencode.mjs', 'src/runners/pi.mjs', 'src/runners/gemini.mjs', 'src/runners/acp.mjs',
    'src/redact.mjs', 'src/sessions/claude.mjs', 'src/sessions/codex.mjs', 'src/sessions/opencode.mjs', 'src/sources/sessions.mjs', 'src/bundle.mjs', 'src/sources/github.mjs', 'src/steps/agent-step.mjs', 'src/steps/analyse.mjs', 'src/prompts/analyse.md', 'src/steps/propose.mjs', 'src/prompts/propose.md', 'src/steps/verify.mjs', 'src/prompts/verify.md', 'src/check.mjs', 'package.json', 'package-lock.json', 'scripts/build-skill.mjs', 'skills/learn-from-mistakes/SKILL.md', 'test/cli.test.mjs', 'test/runners.test.mjs', 'test/sessions.test.mjs', 'test/followup.test.mjs', 'test/init.test.mjs', 'test/github.test.mjs', '.no-mistakes.yaml', 'CONSTRAINTS.md',
    '.agents/skills/verify-learn-from-mistakes/SKILL.md', '.agents/skills/verify-learn-from-mistakes/verify.mjs'].map(path =>
    ({ path, sha256: createHash('sha256').update(readFileSync(join(repo, path))).digest('hex') })) });
let passed = false;
const staged = join(scratch, 'project');
try {
  config.name = 'verification'; // never let a caller config choose an output path
  // A retro needs the agents the user set (the steps here call none); a caller config's own choice is kept.
  if (!config.agent) Object.assign(config, { agent: 'claude', judge_agent: 'codex', agent_config: { ...config.agent_config, claude: { model: 'claude-haiku-5-5' }, codex: { model: 'gpt-6-luna' } } });
  for (const s of sources) {
    copyFileSync(s.path, join(staged, s.copy));
    config.sources[s.id].path = s.copy;
    if (s.type !== 'no-mistakes') continue;
    // The source reads only this project's rows: the staged copy takes the repo row of the example (or of the approved project).
    const db = new DatabaseSync(join(staged, s.copy));
    try { db.prepare('UPDATE repos SET working_path = ? WHERE working_path = ?').run(realpathSync(staged), mode ? project : '/example'); } finally { db.close(); }
  }
  writeFileSync(join(staged, '.learn-from-mistakes.yaml'), stringify(config));
  copyFileSync(labels, join(staged, 'labels.jsonl'));
  copyFileSync(proposals, join(staged, 'proposals.jsonl'));
  // Reuse, don't duplicate, negative/duplicate/occurrence/unread journey coverage.
  run('npm-test', 'npm', ['test', '--ignore-scripts']);
  const cli = join(repo, 'bin/learn-from-mistakes-axi.mjs');
  const stagedLabels = join(staged, 'labels.jsonl');
  const stagedProposals = join(staged, 'proposals.jsonl');
  // The run's own agents are the repo's fake agent as Claude Code (the worker) and Codex (the judge): the drives' PATH holds
  // only them, node for its #! line, and git.
  const agentBin = join(scratch, 'fake-agent');
  mkdirSync(agentBin);
  for (const name of ['claude', 'codex']) symlinkSync(join(repo, 'test', 'fake-agent', 'claude'), join(agentBin, name));
  symlinkSync(process.execPath, join(agentBin, 'node'));
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(agentBin, 'git'));
  const lab = { PATH: agentBin };
  const drive = (name, ...args) => run(name, process.execPath, [cli, ...args, '--dir', staged], 0, lab);
  run('guide', process.execPath, [cli, 'guide']); // the agent procedure, no project config needed
  drive('ingest', 'ingest');
  drive('bare', '--labels', stagedLabels, '--proposals', stagedProposals); // bare command = the report
  drive('count-unread', 'count');
  drive('count-labelled', 'count', '--labels', stagedLabels);
  if (!mode) { // the synthetic config names the cause; a private run never records a change
    drive('changes-empty', 'changes', '--json'); // config only, before any change
    drive('change-applied', 'change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', '--at', '2026-01-02T03:04:05Z',
      '--metric', 'cause_count:server-memory-kill', '--tripwire', '<= 0', '--kind', 'rule',
      '--what', 'Run builds in their own memory group', '--why', 'The memory killer stopped the server three times', '--json');
    run('change-bad-tripwire', process.execPath, [cli, 'change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', '--tripwire', '< x', '--dir', staged], 2, lab);
    drive('changes', 'changes');
    drive('changes-json', 'changes', '--json');
    const [chg] = JSON.parse(readFileSync(join(evidence, 'changes-json.stdout'), 'utf8')).changes;
    assert.deepEqual([chg.metric, chg.tripwire, chg.kind], ['cause_count:server-memory-kill', '<= 0', 'rule'], 'the export does not show the ledger fields');
  }
  drive('report', 'report', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-detail', 'report', '--full', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-json', 'report', '--json', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-full', 'report', '--full', '--json', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('retro', 'retro', '--foreground'); // a saved run in the staged .lfm/lfm.sqlite
  drive('retro-wait', 'retro', '--wait', '1m'); // the same run in a detached worker, waited for
  drive('status', 'status');
  drive('runs', 'runs');
  drive('attach', 'attach'); // the last run has ended: its step lines and states, then the run
  drive('logs', 'logs', '--step', 'collect');
  run('retro-slow', process.execPath, [cli, 'retro', '--dir', staged], 0, { ...lab, LFM_TEST_SLOW_STEP: 'report:20000' }); // test-only flag: report sleeps 20 s, so a failed abort leaves no long worker
  drive('abort', 'abort', '--json'); // the worker ends and the run is cancelled
  assert.equal(JSON.parse(readFileSync(join(evidence, 'abort.stdout'), 'utf8')).run.status, 'cancelled', 'abort does not cancel the run');
  drive('rerun', 'rerun', '--wait', '1m'); // a new run with the current config
  // Config v2: every new key loads and the run completes the same steps; a bad agent exits 2 naming the key.
  const stagedConfig = join(staged, '.learn-from-mistakes.yaml');
  Object.assign(config, { agent: 'claude', judge_agent: 'acp:gemini', agent_config: { 'acp:gemini': { model: 'cheap-model' }, claude: { model: 'claude-haiku-5-5', effort: 'low' } }, agent_timeout: '20m', window: '7d',
    targets: { first_pass: '>= 70', escaped: '<= 0' }, followup: { min_sessions: 3, min_days: 2 }, excerpts: 'off',
    caps: { invocations: 12, bundle_chars: 60000 }, signoff: 'auto', allow_premium: false });
  writeFileSync(stagedConfig, stringify(config));
  drive('retro-v2', 'retro', '--foreground', '--json');
  const bundle = (name) => readFileSync(join(staged, '.lfm', 'runs', String(JSON.parse(readFileSync(join(evidence, `${name}.stdout`), 'utf8')).run.id), 'bundle.md'), 'utf8');
  assert.ok(bundle('retro-v2').includes('## Metrics') && !/^  > /m.test(bundle('retro-v2')), 'the excerpts: off bundle is missing or holds an excerpt');
  writeFileSync(stagedConfig, stringify({ ...config, agent: 3 }));
  run('config-bad-agent', process.execPath, [cli, 'retro', '--foreground', '--dir', staged], 2, lab);
  Object.assign(config, { judge_agent: 'codex', agent_config: { ...config.agent_config, codex: { model: 'gpt-6-luna' } } }); // the drives below call the judge
  // Sessions: one synthetic Claude Code, Codex and OpenCode session each, run in the staged project, each with a failed test.
  const store = join(env.HOME, '.claude', 'projects', 'staged');
  mkdirSync(store, { recursive: true });
  const at = { cwd: staged, sessionId: 's-verify', timestamp: new Date().toISOString() };
  writeFileSync(join(store, 's-verify.jsonl'), [
    { type: 'user', ...at, message: { role: 'user', content: 'Umer: run the tests.' } },
    { type: 'assistant', ...at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', ...at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const rollout = join(env.HOME, '.codex', 'sessions', 'rollout-verify.jsonl');
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Umer: run the tests.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 1\nOutput:\n1 failing' } },
  ].map((r) => JSON.stringify({ timestamp: at.timestamp, ...r })).join('\n') + '\n');
  const threads = new DatabaseSync(join(env.HOME, '.codex', 'state_5.sqlite'));
  threads.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, source TEXT, cwd TEXT)');
  threads.prepare('INSERT INTO threads VALUES (?, ?, 1, ?, ?)').run('cx-verify', rollout, 'cli', staged);
  threads.close();
  mkdirSync(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true });
  const oc = new DatabaseSync(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db')), now = Date.now();
  oc.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`);
  oc.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?)').run('oc-verify', staged, now, now);
  oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'oc-verify', now, '{"role":"user"}');
  oc.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm1', 'oc-verify', now, '{"type":"text","text":"Umer: run the tests."}');
  oc.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 'oc-verify', now + 1, '{"role":"assistant"}');
  oc.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p2', 'm2', 'oc-verify', now + 1, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'npm test' }, metadata: { exit: 1 } } }));
  oc.close();
  const ocBefore = createHash('sha256').update(readFileSync(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'))).digest('hex');
  writeFileSync(stagedConfig, stringify({ ...config, excerpts: 'on', sources: { ...config.sources, sessions: { type: 'sessions' } },
    causes: { ...config.causes, 'test-fails': { description: 'The tests fail.', match: { source: 'sessions', signal: 'test_fail' } } },
    targets: { ...config.targets, 'tool_error_rate': '<= 0.05', 'cause_count:test-fails': '<= 3' } }));
  drive('retro-sessions', 'retro', '--foreground', '--json');
  const out = JSON.parse(readFileSync(join(evidence, 'retro-sessions.stdout'), 'utf8')), metric = (n) => out.metrics.find((m) => m.name === n)?.current;
  assert.ok(out.sources.find((s) => s.type === 'sessions').sessions === 3 && metric('tool_error_rate') === 1, 'the sessions source does not read the three synthetic sessions');
  assert.equal(metric('cause_count:test-fails'), 3, 'the sessions match rule does not tag the failed test run');
  assert.match(bundle('retro-sessions'), /^### \[c\d\] Bash test_fail: 1 events, 1 sessions, 1 days, causes: test-fails\n- \[e\d+\] .+\n  > Exit code 1$/m, 'the bundle does not cluster the failed test run with its excerpt');
  assert.equal(createHash('sha256').update(readFileSync(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'))).digest('hex'), ocBefore, 'the OpenCode store changed');
  const met = (n) => out.metrics.find((m) => m.name === n)?.met;
  assert.deepEqual([met('tool_error_rate'), met('cause_count:test-fails'), met('first_pass')], ['missed', 'met', 'n/a'], 'targets are not compared');
  // Analyse: the fake worker names two findings, one citing an item the bundle lacks; then it answers prose twice.
  run('retro-analyse', process.execPath, [cli, 'retro', '--foreground', '--json', '--dir', staged], 0, { ...lab, FAKE_ANALYSE: 'label' });
  const analysed = JSON.parse(readFileSync(join(evidence, 'retro-analyse.stdout'), 'utf8')).run.id;
  const rows = new DatabaseSync(join(staged, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(rows.prepare('SELECT cause FROM findings WHERE run_id = ?').all(analysed).map((f) => f.cause), ['umer-fixtures-unset'], 'the finding with a ref to no bundle item is not kept');
    assert.deepEqual({ ...rows.prepare('SELECT step, role, runner, exit_status, tokens_in, tokens_out FROM invocations WHERE run_id = ?').get(analysed) },
      { step: 'analyse', role: 'worker', runner: 'claude', exit_status: 'ok', tokens_in: 12, tokens_out: 5 }, 'the invocation row is wrong');
  } finally { rows.close(); }
  drive('logs-analyse', 'logs', '--step', 'analyse');
  assert.match(readFileSync(join(evidence, 'logs-analyse.stdout'), 'utf8'), /problem: findings\[1\]: ref 2 names no bundle item/, 'logs do not show the ref problem');
  run('retro-analyse-prose', process.execPath, [cli, 'retro', '--foreground', '--dir', staged], 1, { ...lab, FAKE_ANALYSE: 'prose' });
  drive('logs-analyse-prose', 'logs', '--step', 'analyse');
  assert.match(readFileSync(join(evidence, 'logs-analyse-prose.stdout'), 'utf8'), /worker answer 2 is not valid: the answer holds no JSON object/, 'logs do not show the validation error');
  if (!mode) { // follow-up: one more failed test run 5 days ago, and a change 3 days ago between it and the three sessions
    writeFileSync(join(store, 's-verify-old.jsonl'), readFileSync(join(store, 's-verify.jsonl'), 'utf8')
      .replaceAll(at.timestamp, new Date(Date.now() - 5 * 86_400_000).toISOString()).replaceAll('s-verify', 's-verify-old'));
    drive('change-followup', 'change', 'applied', '--cause', 'test-fails', '--ref', 'abc1234', '--at', new Date(Date.now() - 3 * 86_400_000).toISOString(), '--tripwire', '<= 0', '--json');
    drive('retro-followup', 'retro', '--foreground', '--json'); // 1 failed test run before the change, 3 after: rollback
    const verdicts = JSON.parse(readFileSync(join(evidence, 'retro-followup.stdout'), 'utf8')).followups.map((f) => [f.change, f.before, f.after, f.verdict]);
    assert.deepEqual(verdicts, [['chg-1', 'n/a', 'n/a', 'no-data'], ['chg-2', 1, 3, 'rollback']], 'the followup step does not give the verdicts');
    // Propose and check: eight fixes for the gate's repeated cause; five are kept, three are problems; one goes into the ledger.
    run('retro-propose', process.execPath, [cli, 'retro', '--foreground', '--json', '--dir', staged], 0, { ...lab, FAKE_ANALYSE: 'label', FAKE_PROPOSE: 'eight', FAKE_CAUSE: 'agent-exit-wait', FAKE_REFUTE: 'p2' });
    const proposed = JSON.parse(readFileSync(join(evidence, 'retro-propose.stdout'), 'utf8'));
    assert.deepEqual(proposed.fixes.map((f) => [f.n, f.cause, f.tripwire]), [1, 2, 3, 4, 5].map((n) => [n, 'agent-exit-wait', '<= 0']), 'check does not keep five ranked fixes');
    const db = new DatabaseSync(join(staged, '.lfm', 'lfm.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT change_id, reason IS NOT NULL AS given FROM followups WHERE run_id = ?').all(proposed.run.id).map((f) => [f.change_id, f.given]), [['chg-1', 1], ['chg-2', 1]], 'a follow-up that is not keep has no reason');
      assert.deepEqual(db.prepare('SELECT verdict FROM proposals WHERE run_id = ? ORDER BY id').all(proposed.run.id).map((f) => f.verdict), ['confirmed', 'refuted', ...Array(6).fill('confirmed')], 'the judge\'s verdicts are not on the fixes');
      assert.deepEqual({ ...db.prepare(`SELECT role, runner FROM invocations WHERE run_id = ? AND step = 'verify'`).get(proposed.run.id) }, { role: 'judge', runner: 'codex' }, 'the judge is not the second agent');
    } finally { db.close(); }
    drive('logs-verify', 'logs', '--step', 'verify');
    assert.match(readFileSync(join(evidence, 'logs-verify.stdout'), 'utf8'), /refuted: p2[\s\S]*verdicts: 8 confirmed, 0 weakened, 1 refuted, 0 not judged/, 'logs do not show the judge\'s verdicts');
    drive('logs-check', 'logs', '--step', 'check');
    assert.match(readFileSync(join(evidence, 'logs-check.stdout'), 'utf8'), /problem: proposals\[5\]: more than 5 fixes[\s\S]*problem: proposals\[6\]: its cause did not repeat[\s\S]*problem: proposals\[7\]: no tripwire[\s\S]*fixes: 5 kept of 8, problems: 3/, 'logs do not show the check problems');
    drive('change-proposal', 'change', 'applied', '--proposal', `${proposed.run.id}:1`, '--ref', 'abc1234', '--json');
    assert.deepEqual((({ cause, metric, tripwire }) => [cause, metric, tripwire])(JSON.parse(readFileSync(join(evidence, 'change-proposal.stdout'), 'utf8'))),
      ['agent-exit-wait', 'cause_count:agent-exit-wait', '<= 0'], '--proposal does not copy the fix into the ledger');
  }
  const hold = new DatabaseSync(join(staged, '.lfm', 'lfm.sqlite')); // a busy store: another process holds its write lock
  hold.exec('BEGIN IMMEDIATE');
  run('status-busy', process.execPath, [cli, 'status', '--dir', staged], 2, lab);
  hold.exec('ROLLBACK');
  hold.close();
  assert.match(readFileSync(join(evidence, 'status-busy.stderr'), 'utf8'), /is busy: .*\nnext: learn-from-mistakes-axi status   # wait a moment and check the running run; abort --run <id> stops it/, 'a busy store does not say to wait');
  drive('status-after-busy', 'status'); // the store and its run history are kept
  writeFileSync(stagedConfig, stringify(config));
  // No agent set anywhere (no project config, no global file yet): the tool picks none and says to ask the user.
  run('agents-ask', process.execPath, [cli, 'agents', '--json'], 2);
  assert.match(readFileSync(join(evidence, 'agents-ask.stderr'), 'utf8'), /^error: ask the user which agent to use: agent and judge_agent are not set in .*\.learn-from-mistakes\.yaml, and the tool never picks one\.[^\n]*\nnext: learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model>   # with the user's answer\n/m, 'agents picked an agent or did not say to ask');
  // init in a fresh project holding only a defect log, with two fake agent CLIs as the whole PATH; a second init
  // leaves the config byte-identical.
  const fresh = join(scratch, 'fresh'), fakes = join(scratch, 'agents');
  for (const d of [join(fresh, 'docs'), fakes]) mkdirSync(d, { recursive: true });
  copyFileSync(join(repo, 'examples', 'defects.md'), join(fresh, 'docs', 'defects.md'));
  writeFileSync(join(fresh, 'reviews.md'), '- 2026-10-12 Umer: a synthetic review finding\n');
  writeFileSync(join(fakes, 'claude'), '#!/bin/sh\necho "1.0.0"\n', { mode: 0o755 });
  writeFileSync(join(fakes, 'opencode'), '#!/bin/sh\n[ "$1 $2" = "auth list" ] && { echo "1 credentials"; exit 0; }\necho "1.0.0"\n', { mode: 0o755 }); // logged in, for doctor
  run('init-unset', process.execPath, [cli, 'init', '-y', '--no-skill', '--dir', fresh], 0, { PATH: fakes }); // writes no agent: names the save command
  assert.match(readFileSync(join(evidence, 'init-unset.stderr'), 'utf8'), /^next: learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir /m, 'init with no agent chosen does not say to ask');
  run('init', process.execPath, [cli, 'init', '--agent', 'claude', '--model', 'claude-haiku-5-5', '--judge-agent', 'opencode', '--judge-model', 'opencode-go/muse-spark-1.3-contributor', '--dir', fresh], 0, { PATH: fakes });
  assert.deepEqual(['agent', 'judge_agent'].map((k) => parse(readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8'))[k]), ['claude', 'opencode'], 'init did not save the chosen agents');
  const written = readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8');
  save('init.yaml', written);
  assert.deepEqual([Object.keys(parse(written).sources).slice(0, 2), Object.keys(parse(written).causes)], [['log', 'reviews'], ['test-failed', 'command-failed', 'tool-misused', 'user-corrected']], 'init did not write the review log or the starter causes');
  const globalWritten = readFileSync(join(env.HOME, '.learn-from-mistakes', 'config.yaml'), 'utf8'); // init writes the global agent config once
  assert.equal(parse(globalWritten), null, 'init set a key in the global file: every key there is commented');
  save('init-global.yaml', globalWritten);
  run('init-again', process.execPath, [cli, 'init', '--json', '--dir', fresh], 0, { PATH: fakes });
  assert.equal(readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8'), written, 'a second init changed the config');
  assert.equal(readFileSync(join(env.HOME, '.learn-from-mistakes', 'config.yaml'), 'utf8'), globalWritten, 'a second init changed the global config');
  // doctor on the written config (ok and warn lines, exit 0), then with its defect log gone (a fail with its fix, exit 1).
  run('doctor', process.execPath, [cli, 'doctor', '--dir', fresh], 0, { PATH: fakes });
  assert.match(readFileSync(join(evidence, 'doctor.stdout'), 'utf8'), /^warn sign-off +sign-off-axi is not on PATH: .*\n {5}fix: npm i -g sign-off-axi /m, 'doctor does not look for sign-off-axi with a fix');
  rmSync(join(fresh, 'docs', 'defects.md'));
  run('doctor-missing-log', process.execPath, [cli, 'doctor', '--dir', fresh], 1, { PATH: fakes });
  assert.match(readFileSync(join(evidence, 'doctor-missing-log.stdout'), 'utf8'), /^fail source log .*\n {5}fix: check sources\.log\.path in \S+\.learn-from-mistakes\.yaml, or create it: touch \S+\/docs\/defects\.md\n/m, 'doctor names no fix for the missing log');
  run('init-pinned-clash', process.execPath, [cli, 'init', '--agent', 'claude', '--judge-agent', 'claude', '--dir', join(fresh, 'docs')], 2, { PATH: fakes });
  run('init-one-agent-two-models', process.execPath, [cli, 'init', '--agent', 'claude', '--model', 'umer-a', '--judge-agent', 'claude', '--judge-model', 'umer-b', '--dir', join(fresh, 'docs')], 2, { PATH: fakes });
  assert.match(readFileSync(join(evidence, 'init-one-agent-two-models.stderr'), 'utf8'), /both claude, and agent_config holds one model per agent.*\nnext: learn-from-mistakes-axi init --agent claude --model umer-a --judge-agent <another agent> --judge-model umer-b /, 'the clash does not state the one-model rule');
  if (packageProof) {
    const pack = join(evidence, 'pack');
    mkdirSync(pack, { mode: 0o700 });
    run('npm-pack', 'npm', ['pack', '--pack-destination', pack]);
    const tarball = join(pack, readdirSync(pack).find((f) => f.endsWith('.tgz')));
    const manifest = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8' }).stdout.trim().split('\n');
    save('pack.manifest.txt', manifest.join('\n'));
    for (const f of ['bin/learn-from-mistakes-axi.mjs', 'src/config.mjs', 'src/metrics.mjs', 'src/followup.mjs', 'src/init.mjs', 'src/doctor.mjs', 'src/sources/markdown-log.mjs', 'src/sources/no-mistakes.mjs', 'src/run.mjs', 'src/store.mjs',
      'src/runners/index.mjs', 'src/runners/byokit.mjs', 'src/runners/claude.mjs', 'src/runners/codex.mjs', 'src/runners/opencode.mjs', 'src/runners/pi.mjs', 'src/runners/gemini.mjs', 'src/runners/acp.mjs',
      'src/redact.mjs', 'src/sessions/claude.mjs', 'src/sessions/codex.mjs', 'src/sessions/opencode.mjs', 'src/sources/sessions.mjs', 'src/bundle.mjs', 'src/sources/github.mjs', 'src/steps/agent-step.mjs', 'src/steps/analyse.mjs', 'src/prompts/analyse.md', 'src/steps/propose.mjs', 'src/prompts/propose.md', 'src/steps/verify.mjs', 'src/prompts/verify.md', 'src/check.mjs', 'package.json']) assert.ok(manifest.includes(`package/${f}`), `tarball omits ${f}`);
    assert.ok(manifest.some((f) => f.endsWith('skills/learn-from-mistakes/SKILL.md')), 'tarball omits the standalone skill');
    assert.ok(!manifest.some((f) => /^\s*package\/(test|examples)\//.test(f)), 'tarball bundles test/examples');
    const prefix = join(scratch, 'prefix');
    run('npm-install-pack', 'npm', ['install', '-g', '--prefix', prefix, tarball]);
    const installed = join(prefix, 'bin', 'learn-from-mistakes-axi');
    run('packed-version', installed, ['--version']);
    run('packed-help', installed, ['--help']);
    run('packed-guide', installed, ['guide']);
    run('packed-agents', installed, ['agents', '--json'], 2); // no agent set: the packed bin also says to ask the user
    run('packed-report', installed, ['report', '--json', '--dir', staged, '--labels', stagedLabels, '--proposals', stagedProposals]);
    assert.equal(JSON.parse(readFileSync(join(evidence, 'packed-report.stdout'), 'utf8')).schema, 'lfm-report.v1', 'packed bin does not drive the report');
    if (!mode) {
      run('packed-changes', installed, ['changes', '--json', '--dir', staged]);
      assert.equal(JSON.parse(readFileSync(join(evidence, 'packed-changes.stdout'), 'utf8')).schema, 'lfm-changes.v1', 'packed bin does not drive the export');
    }
    run('packed-retro', installed, ['retro', '--wait', '1m', '--json', '--dir', staged], 0, lab); // the installed bin spawns its own worker; the ledger's follow-ups ask the fake agent
    const packedRun = JSON.parse(readFileSync(join(evidence, 'packed-retro.stdout'), 'utf8'));
    assert.ok(packedRun.run.status === 'completed' && packedRun.steps.every((s) => s.status === 'completed'), 'packed bin does not complete a detached run');
    // The same e2e journeys (the ledger and lfm-changes.v1 export included), driven through the installed bin.
    run('packed-npm-test', 'npm', ['test', '--ignore-scripts'], 0, { LFM_CLI: installed });
    assert.ok(existsSync(join(prefix, 'lib', 'node_modules', 'learn-from-mistakes-axi', 'skills', 'learn-from-mistakes', 'SKILL.md')), 'packaged standalone skill is missing');
    save('pack.json', { tarball: tarball.slice(evidence.length + 1), sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'), files: manifest.length });
  }
  passed = true;
} finally {
  const after = hashes();
  save('inputs.after.json', after);
  save('result.json', { commandsPassed: passed, inputsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    limitation: 'Review output against the skill feature map; trusted no-mistakes prompt consumption is a separate proof.' });
  if (existsSync(join(staged, '.lfm'))) cpSync(join(staged, '.lfm'), join(evidence, 'state'), { recursive: true }); // retain the ingest artifacts
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); // retries ENOTEMPTY/EBUSY from late writers
  assert.deepEqual(after, before, 'Original inputs changed; proof fails');
}
console.log(`CLI commands and existing e2e suite passed. Review private evidence: ${evidence}`);
