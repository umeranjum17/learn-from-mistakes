#!/usr/bin/env node
// Public CLI proof; the existing e2e journeys own behavioral assertions.
// Driven by done-done: journeys `cli` and `package` in .done-done.yaml run this with
// DONE_DONE_EVIDENCE_ROOT set (the run's own folder); direct runs take the evidence dir as argv[0].
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parse, stringify } from 'yaml';

const repo = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const raw = process.argv.slice(2);
const packageProof = raw.includes('--package');
const [destination, mode, sourceDir, ...extra] = raw.filter((a) => a !== '--package');
const fromEnv = process.env.DONE_DONE_EVIDENCE_ROOT;
assert((destination && isAbsolute(destination)) || (fromEnv && isAbsolute(resolve(fromEnv))), 'Provide an absolute private evidence directory');
assert(!extra.length && (!mode || (mode === '--private' && sourceDir)),
  'usage: node scripts/verify-journeys.mjs [/absolute/evidence] [--private /project] [--package]');
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
// Resolve existing ancestors too: a symlinked output parent must not redirect into the repo.
function canonical(path) {
  path = resolve(path);
  return existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}
const evidence = canonical(destination ?? fromEnv);
assert(!inside(repo, evidence) && !inside(evidence, repo), 'Evidence must be outside, and not contain, the checkout');
// done-done hands the journey a fresh folder per run (the journey command may already
// have written there); direct runs must name a new or empty folder, never overwrite a prior proof.
assert((!destination && fromEnv) || !existsSync(evidence) || (statSync(evidence).isDirectory() && readdirSync(evidence).length === 0), 'Evidence must be new or empty; never overwrite a prior proof');
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
for (const input of inputs) {
  assert(statSync(input).isFile(), `Not a regular input: ${input}`);
  assert(!inside(dirname(input), evidence) && !inside(evidence, input), 'Evidence must not overlap any input directory');
}
const hashes = () => inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const before = hashes();
mkdirSync(evidence, { recursive: true, mode: 0o700 });
chmodSync(evidence, 0o700);
const save = (name, value) => writeFileSync(join(evidence, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
// The run's private scratch, in the tests' temp pattern (a fresh mkdtemp dir) so it stays out of the evidence
// folder. Every exit path removes it, so a killed or failed run never leaves leftover files behind.
const scratch = mkdtempSync(join(tmpdir(), 'lfm-verify-'));
const cleanupScratch = () => rmSync(scratch, { recursive: true, force: true, maxRetries: 5 }); // retries ENOTEMPTY/EBUSY from late writers
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupScratch(); process.exit(1); });
process.on('exit', cleanupScratch);
for (const dir of ['home', 'tmp', 'xdg', 'runtime', 'project']) mkdirSync(join(scratch, dir));
const env = { ...process.env, HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'),
  XDG_CONFIG_HOME: join(scratch, 'xdg'), XDG_CACHE_HOME: join(scratch, 'xdg'), XDG_DATA_HOME: join(scratch, 'xdg'), XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  npm_config_cache: join(scratch, 'npm-cache'), GIT_CEILING_DIRECTORIES: realpathSync(scratch) }; // the staged project is no part of a repo above it
delete env.LFM_CLI; // only packed-npm-test points the journeys at another bin
env.LFM_HOME = join(env.HOME, '.learn-from-mistakes'); // explicit isolated global config; project state stays in .lfm/
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
  node: process.version, mode: mode ? 'private opt-in' : 'synthetic', inputs: before, sources,
  candidate: ['src/signoff.mjs', 'bin/learn-from-mistakes-axi.mjs', 'src/config.mjs', 'src/metrics.mjs', 'src/followup.mjs', 'src/init.mjs', 'src/doctor.mjs', 'src/sources/markdown-log.mjs', 'src/sources/no-mistakes.mjs', 'src/sources/done-done.mjs', 'src/sources/firstmate.mjs', 'src/run.mjs', 'src/store.mjs',
    'src/runners/index.mjs', 'src/runners/byokit.mjs', 'src/runners/claude.mjs', 'src/runners/codex.mjs', 'src/runners/opencode.mjs', 'src/runners/pi.mjs', 'src/runners/gemini.mjs', 'src/runners/acp.mjs',
    'src/redact.mjs', 'src/sessions/claude.mjs', 'src/sessions/codex.mjs', 'src/sessions/opencode.mjs', 'src/sessions/pi.mjs', 'src/sessions/gemini.mjs', 'src/sources/sessions.mjs', 'src/bundle.mjs', 'src/sources/github.mjs', 'src/steps/agent-step.mjs', 'src/steps/analyse.mjs', 'src/prompts/analyse.md', 'src/steps/propose.mjs', 'src/prompts/propose.md', 'src/steps/verify.mjs', 'src/prompts/verify.md', 'src/check.mjs', 'src/apply.mjs', 'src/prompts/apply.md', 'package.json', 'package-lock.json', 'README.md', 'scripts/build-skill.mjs', 'scripts/verify-journeys.mjs', 'skills/learn-from-mistakes/SKILL.md', 'test/cli.test.mjs', 'test/runners.test.mjs', 'test/sessions.test.mjs', 'test/followup.test.mjs', 'test/init.test.mjs', 'test/github.test.mjs', '.done-done.yaml', '.github/workflows/release.yml', '.no-mistakes.yaml', 'CONSTRAINTS.md'].map(path =>
    ({ path, sha256: createHash('sha256').update(readFileSync(join(repo, path))).digest('hex') })) });
let passed = false;
const staged = join(scratch, 'project');
try {
  config.name = 'verification'; // never let a caller config choose an output path
  // A retro needs the agents the user set (the steps here call none); a caller config's own choice is kept.
  if (!config.agent) Object.assign(config, { agent: 'claude', judge_agent: 'codex', agent_config: { ...config.agent_config, claude: { model: 'umer-worker-model' }, codex: { model: 'umer-judge-model' } } });
  for (const s of sources) {
    copyFileSync(s.path, join(staged, s.copy));
    config.sources[s.id].path = s.copy;
    if (s.type !== 'no-mistakes') continue;
    // The source reads only this project's rows: the staged copy takes the repo row of the example (or of the approved project).
    const db = new DatabaseSync(join(staged, s.copy));
    try { db.prepare('UPDATE repos SET working_path = ? WHERE working_path = ?').run(realpathSync(staged), mode ? project : '/example'); } finally { db.close(); }
  }
  writeFileSync(join(staged, '.learn-from-mistakes.yaml'), stringify(config));
  // Reuse, don't duplicate, negative/duplicate/occurrence/unread journey coverage.
  // LFM_VERIFY_TESTS (space-separated test files) narrows this step to the changed parts' tests; unset runs the full suite.
  const picked = process.env.LFM_VERIFY_TESTS?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (picked.length) run('npm-test', process.execPath, ['--test', ...picked]); else run('npm-test', 'npm', ['test', '--ignore-scripts']);
  const cli = join(repo, 'bin/learn-from-mistakes-axi.mjs');
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
  for (const args of [['ingest'], ['count'], ['report', '--labels', 'x.jsonl'], ['report', '--proposals', 'x.jsonl']])
    run(`removed-${(args[1] ?? args[0]).replace(/^--/, '')}`, process.execPath, [cli, ...args, '--dir', staged], 2, lab); // the manual flow is gone
  run('report-no-run', process.execPath, [cli, 'report', '--dir', staged], 3, lab); // no completed run yet
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
  drive('retro', 'retro', '--foreground'); // a saved run in the staged .lfm/lfm.sqlite
  drive('report', 'report'); // the last run's report
  drive('report-detail', 'report', '--full');
  drive('report-json', 'report', '--json');
  drive('report-full', 'report', '--full', '--json');
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
  Object.assign(config, { agent: 'claude', judge_agent: 'codex', agent_config: { codex: { model: 'umer-judge-model' }, claude: { model: 'umer-worker-model', effort: 'low' } }, agent_timeout: '20m', window: '7d',
    targets: { first_pass: '>= 70', escaped: '<= 0' }, followup: { min_sessions: 3, min_days: 2 }, excerpts: 'off',
    caps: { invocations: 14, bundle_chars: 60000 }, signoff: 'on' });
  // In-window canary records, one sentence per source type this journey configures, so the excerpts: off check
  // has in-window records to hide: the run must count them, and none of their text may reach the bundle, the
  // report or the drive's own output. Seeded only for this run - later journeys read the same staged sources.
  const logCopy = sources.find((s) => s.type === 'markdown-log').copy, dbCopy = sources.find((s) => s.type === 'no-mistakes').copy;
  const canary = { log: 'lfm-canary-log-text', gate: 'lfm-canary-gate-text' }, seedLog = `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [tests] ${canary.log}\n`;
  appendFileSync(join(staged, logCopy), seedLog);
  const seed = new DatabaseSync(join(staged, dbCopy)), nowSec = Math.floor(Date.now() / 1000), repoRow = seed.prepare('SELECT id FROM repos ORDER BY id LIMIT 1').get();
  seed.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('canary-run', repoRow.id, 'canary');
  seed.prepare('INSERT INTO step_results VALUES (?, ?, ?, ?, ?, ?, ?)').run('canary-step', 'canary-run', 'test', 'failed', canary.gate, nowSec - 60, nowSec);
  seed.close();
  writeFileSync(stagedConfig, stringify(config));
  drive('retro-v2', 'retro', '--foreground', '--json');
  const runId = (name) => JSON.parse(readFileSync(join(evidence, `${name}.stdout`), 'utf8')).run.id;
  const bundle = (name) => readFileSync(join(staged, '.lfm', 'runs', String(runId(name)), 'bundle.md'), 'utf8');
  const v2run = JSON.parse(readFileSync(join(evidence, 'retro-v2.stdout'), 'utf8')), counted = (name) => v2run.metrics.find((m) => m.name === name)?.current;
  for (const [where, text] of [['bundle.md', bundle('retro-v2')], ['report.txt', readFileSync(join(staged, '.lfm', 'runs', String(runId('retro-v2')), 'report.txt'), 'utf8')],
    ['stdout', readFileSync(join(evidence, 'retro-v2.stdout'), 'utf8')], ['stderr', readFileSync(join(evidence, 'retro-v2.stderr'), 'utf8')]])
    for (const line of Object.values(canary)) assert.ok(!text.includes(line), `the excerpts-off ${where} holds the canary record text`);
  assert.ok(counted('defects') >= 1 && counted('gate_failures') >= 1, 'the excerpts-off window did not count the seeded canary records');
  assert.ok(bundle('retro-v2').includes('## Metrics') && !/^  > /m.test(bundle('retro-v2')), 'the excerpts: off bundle is missing or holds an excerpt');
  writeFileSync(join(staged, logCopy), readFileSync(join(staged, logCopy), 'utf8').replace(seedLog, ''));
  const unseed = new DatabaseSync(join(staged, dbCopy));
  try { unseed.exec("DELETE FROM step_results WHERE id = 'canary-step'; DELETE FROM runs WHERE id = 'canary-run'"); } finally { unseed.close(); }
  writeFileSync(stagedConfig, stringify({ ...config, agent: 3 }));
  run('config-bad-agent', process.execPath, [cli, 'retro', '--foreground', '--dir', staged], 2, lab);
  // A judge on the worker's agent and model is the user's choice: the retro runs, and the judge still answers.
  writeFileSync(stagedConfig, stringify({ ...config, judge_agent: 'claude' }));
  run('retro-judge-same-agent', process.execPath, [cli, 'retro', '--foreground', '--json', '--dir', staged], 0, lab);
  assert.equal(JSON.parse(readFileSync(join(evidence, 'retro-judge-same-agent.stdout'), 'utf8')).run.status, 'completed', 'a judge on the worker\'s agent did not complete the retro');
  Object.assign(config, { judge_agent: 'codex', agent_config: { ...config.agent_config, codex: { model: 'umer-judge-model' } } }); // the drives below call the judge
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
  writeFileSync(stagedConfig, stringify({ ...config, excerpts: 'on', sources: { ...config.sources, sessions: { type: 'sessions', agents: ['claude', 'codex', 'opencode'] } },
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
  if (!mode) appendFileSync(join(staged, sources.find((x) => x.type === 'markdown-log').copy), `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [tests] Umer's tests failed: UMER_FIXTURES was unset.\n- [tests] They failed again for the same reason.\n`); // two records in this window to label
  run('retro-analyse', process.execPath, [cli, 'retro', '--wait', '1m', '--json', '--dir', staged], 0, { ...lab, FAKE_ANALYSE: 'label' });
  const { run: { id: analysed }, result } = JSON.parse(readFileSync(join(evidence, 'retro-analyse.stdout'), 'utf8'));
  assert.deepEqual(result.findings.map((f) => f.cause), ['umer-fixtures-unset'], 'retro --wait does not show the worker\'s finding');
  drive('report-run', 'report', '--json'); // lfm-report.v2 counts the run's labels
  run('bare', process.execPath, [cli, '--dir', staged], 0, lab); // the bare command: the last run's status and its summary line
  const v2 = JSON.parse(readFileSync(join(evidence, 'report-run.stdout'), 'utf8'));
  assert.deepEqual([v2.schema, v2.run, existsSync(v2.report_txt), Array.isArray(v2.metrics)], ['lfm-report.v2', analysed, true, true], 'report --json is not lfm-report.v2 for the run');
  assert.match(readFileSync(join(evidence, 'bare.stdout'), 'utf8'), new RegExp(`^run:\\n  id: ${analysed}\\n  status: completed\\n[\\s\\S]*^summary: "repeated: `, 'm'), 'the bare command does not show the last run and its summary');
  if (!mode) {
    assert.deepEqual([result.labelled, result.causes.find((c) => c.cause === 'other')?.incidents], [2, 2], 'retro --wait does not show the counted causes');
  }
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
    // Verify, propose, verify-fixes and check: eight fixes for the gate's repeated cause; the judge refutes fix 2 (a problem) and weakens
    // fix 3 (ranked last of the five kept); three are problems; one goes into the ledger.
    run('retro-propose', process.execPath, [cli, 'retro', '--foreground', '--json', '--dir', staged], 0, { ...lab, FAKE_ANALYSE: 'label', FAKE_PROPOSE: 'eight', FAKE_CAUSE: 'agent-exit-wait', FAKE_REFUTE: 'p2', FAKE_WEAKEN: 'p3', FAKE_TARGET: 'AGENTS.md' });
    const proposed = JSON.parse(readFileSync(join(evidence, 'retro-propose.stdout'), 'utf8'));
    assert.deepEqual(proposed.fixes.map((f) => [f.n, f.cause, f.tripwire, f.verdict]), [1, 2, 3, 4, 5].map((n) => [n, 'agent-exit-wait', '<= 0', n === 5 ? 'weakened' : 'confirmed']), 'check does not keep five ranked fixes, the weakened one last');
    const db = new DatabaseSync(join(staged, '.lfm', 'lfm.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT change_id, reason IS NOT NULL AS given FROM followups WHERE run_id = ?').all(proposed.run.id).map((f) => [f.change_id, f.given]), [['chg-1', 1], ['chg-2', 1]], 'a follow-up that is not keep has no reason');
      assert.deepEqual(db.prepare('SELECT verdict FROM proposals WHERE run_id = ? ORDER BY id').all(proposed.run.id).map((f) => f.verdict), ['confirmed', 'refuted', 'weakened', ...Array(5).fill('confirmed')], 'the judge\'s verdicts are not on the fixes');
      assert.deepEqual(db.prepare(`SELECT step, role, runner FROM invocations WHERE run_id = ? AND role = 'judge' ORDER BY id`).all(proposed.run.id).map((r) => ({ ...r })),
        ['verify', 'verify-fixes'].map((step) => ({ step, role: 'judge', runner: 'codex' })), 'the judge is not the second agent, or does not judge the findings before propose and the fixes after it');
    } finally { db.close(); }
    // report.txt: the seven sections for a person, an Apply or Skip question per kept fix and a yes or no one per rollback.
    const reportTxt = readFileSync(join(staged, '.lfm', 'runs', String(proposed.run.id), 'report.txt'), 'utf8');
    save('report.txt', reportTxt);
    assert.match(reportTxt, /^1\. Short answer$[\s\S]*^2\. Numbers$[\s\S]*^3\. Last changes$[\s\S]*^4\. Repeated mistakes$[\s\S]*^5\. Fixes$[\s\S]*^6\. Not checked$[\s\S]*^7\. Questions for you\n1\. Apply fix 1, for agent-exit-wait\? Answer Apply or Skip\.$/m, 'report.txt does not have the seven sections and the questions');
    assert.match(reportTxt, /^6\. Roll back change chg-2\? Answer yes or no\.$/m, 'report.txt does not ask to roll back chg-2');
    assert.ok(!reportTxt.includes(staged), 'report.txt shows a path outside its evidence lines');
    drive('logs-verify-fixes', 'logs', '--step', 'verify-fixes');
    assert.match(readFileSync(join(evidence, 'logs-verify-fixes.stdout'), 'utf8'), /refuted: p2[\s\S]*weakened: p3[\s\S]*verdicts: 6 confirmed, 1 weakened, 1 refuted/, 'logs do not show the judge\'s verdicts');
    drive('logs-check', 'logs', '--step', 'check');
    assert.match(readFileSync(join(evidence, 'logs-check.stdout'), 'utf8'), /problem: proposals\[1\]: the judge refuted it[\s\S]*problem: proposals\[6\]: its cause did not repeat[\s\S]*problem: proposals\[7\]: no tripwire[\s\S]*fixes: 5 kept of 8, problems: 3/, 'logs do not show the check problems');
    run('signoff-fallback', process.execPath, [cli, 'signoff', 'post', '--run', String(proposed.run.id), '--dir', staged], 0, { PATH: agentBin });
    const fallbackOut = readFileSync(join(evidence, 'signoff-fallback.stdout'), 'utf8');
    assert.match(fallbackOut, /kept: lfm-\d+-\d+-[0-9a-f]{8}[\s\S]*npm i -g sign-off-axi[\s\S]*report\.txt/);
    assert.ok(!fallbackOut.includes('Repeated cause:'), 'fallback stdout carries the fix title');
    assert.ok(!fallbackOut.includes('Give each worker its own cache directory'), 'fallback stdout carries the change text');
    const signDir = join(scratch, 'signoff'); mkdirSync(signDir);
    copyFileSync(join(repo, 'test', 'fake-agent', 'sign-off-axi'), join(agentBin, 'sign-off-axi')); chmodSync(join(agentBin, 'sign-off-axi'), 0o755);
    run('signoff-post', process.execPath, [cli, 'signoff', 'post', '--dir', staged], 0, { PATH: agentBin, FAKE_SIGNOFF_DIR: signDir });
    const posted = JSON.parse(readFileSync(join(signDir, 'board.json'), 'utf8'));
    writeFileSync(join(signDir, 'answers.json'), JSON.stringify({ [posted[0].key]: { answer: 'apply', label: 'Apply', close: 'done', at: '2026-10-13T22:00:52Z' }, [posted[1].key]: { answer: 'skip', label: 'Skip', close: 'done', at: '2026-10-13T22:00:52Z' } }));
    run('signoff-answers', process.execPath, [cli, 'signoff', 'answers', '--dir', staged], 0, { PATH: agentBin, FAKE_SIGNOFF_DIR: signDir });
    save('signoff-board.json', posted); save('signoff-calls.jsonl', readFileSync(join(signDir, 'calls.jsonl'), 'utf8'));
    const git = (...a) => spawnSync(join(agentBin, 'git'), ['-C', staged, ...a], { encoding: 'utf8' }).stdout.trim(); writeFileSync(join(staged, 'AGENTS.md'), '# Rules\n');
    for (const a of [['init', '-q'], ['config', 'user.name', 'Umer'], ['config', 'user.email', 'umer@example.com'], ['add', '-A'], ['commit', '-qm', 'start']]) git(...a);
    drive('apply', 'apply');
    assert.match(readFileSync(join(evidence, 'apply.stdout'), 'utf8'), new RegExp(`^applied: fix ${proposed.run.id}:1 on branch lfm/${proposed.run.id}-1, commit [0-9a-f]{12}, ledger chg-\\d+$`, 'm'), 'apply does not make fix 1');
    assert.deepEqual([git('rev-parse', `lfm/${proposed.run.id}-1^`), git('status', '--porcelain')], [git('rev-parse', 'HEAD'), ''], 'apply moved HEAD or touched the work tree');
    drive('change-proposal', 'change', 'applied', '--proposal', `${proposed.run.id}:1`, '--ref', git('rev-parse', 'HEAD').slice(0, 12), '--json'); // #129: in a git project the ref must name a commit
    assert.deepEqual((({ cause, metric, tripwire }) => [cause, metric, tripwire])(JSON.parse(readFileSync(join(evidence, 'change-proposal.stdout'), 'utf8'))),
      ['agent-exit-wait', 'cause_count:agent-exit-wait', '<= 0'], '--proposal does not copy the fix into the ledger');
  }
  const hold = new DatabaseSync(join(staged, '.lfm', 'lfm.sqlite')); // a busy store: another process holds its write lock
  hold.exec('BEGIN IMMEDIATE');
  run('status-busy', process.execPath, [cli, 'status', '--dir', staged], 0, lab); // a read does not wait for the lock
  run('retro-busy', process.execPath, [cli, 'retro', '--foreground', '--dir', staged], 2, lab);
  hold.exec('ROLLBACK');
  hold.close();
  assert.match(readFileSync(join(evidence, 'retro-busy.stderr'), 'utf8'), /is busy: .*\nnext: learn-from-mistakes-axi status   # wait a moment and check the running run; abort --run <id> stops it/, 'a busy store does not say to wait');
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
  assert.match(readFileSync(join(evidence, 'init-unset.stdout'), 'utf8'), /sessions: ask the user which agents' sessions to read \(local stores: claude, codex, opencode[^)]*\), then run learn-from-mistakes-axi init --sessions <agent>,<agent> --dir /, 'init without a terminal does not ask which agents\' sessions to read');
  assert.equal(parse(readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8')).sources.sessions, undefined, 'init wrote a sessions source nobody named');
  rmSync(join(fresh, '.learn-from-mistakes.yaml'));
  run('init', process.execPath, [cli, 'init', '--no-skill', '--agent', 'claude', '--model', 'umer-worker-model', '--judge-agent', 'opencode', '--judge-model', 'umer/umer-judge-model', '--sessions', 'claude,pi', '--dir', fresh], 0, { PATH: fakes });
  assert.deepEqual(['agent', 'judge_agent', 'sources'].map((k) => parse(readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8'))[k]).map((v) => v.sessions?.agents ?? v), ['claude', 'opencode', ['claude', 'pi']], 'init did not save the chosen agents and the named sessions agents');
  const written = readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8');
  save('init.yaml', written);
  assert.deepEqual([Object.keys(parse(written).sources).slice(0, 2), Object.keys(parse(written).causes)], [['log', 'reviews'], ['test-failed', 'command-failed', 'tool-misused', 'user-corrected']], 'init did not write the review log or the starter causes');
  const globalWritten = readFileSync(join(env.HOME, '.learn-from-mistakes', 'config.yaml'), 'utf8'); // init writes the global agent config once
  assert.equal(parse(globalWritten), null, 'init set a key in the global file: every key there is commented');
  save('init-global.yaml', globalWritten);
  run('init-again', process.execPath, [cli, 'init', '--no-skill', '--json', '--dir', fresh], 0, { PATH: fakes });
  assert.equal(readFileSync(join(fresh, '.learn-from-mistakes.yaml'), 'utf8'), written, 'a second init changed the config');
  assert.equal(readFileSync(join(env.HOME, '.learn-from-mistakes', 'config.yaml'), 'utf8'), globalWritten, 'a second init changed the global config');
  // doctor on the written config (ok and warn lines, exit 0), then with its defect log gone (a fail with its fix, exit 1).
  run('doctor', process.execPath, [cli, 'doctor', '--dir', fresh], 0, { PATH: fakes });
  assert.match(readFileSync(join(evidence, 'doctor.stdout'), 'utf8'), /^warn sign-off +sign-off-axi is not on PATH: .*\n {5}fix: npm i -g sign-off-axi /m, 'doctor does not look for sign-off-axi with a fix');
  rmSync(join(fresh, 'docs', 'defects.md'));
  run('doctor-missing-log', process.execPath, [cli, 'doctor', '--dir', fresh], 1, { PATH: fakes });
  assert.match(readFileSync(join(evidence, 'doctor-missing-log.stdout'), 'utf8'), /^fail source log .*\n {5}fix: check sources\.log\.path in \S+\.learn-from-mistakes\.yaml, or create it: touch \S+\/docs\/defects\.md\n/m, 'doctor names no fix for the missing log');
  run('init-one-agent-two-models', process.execPath, [cli, 'init', '--no-skill', '--agent', 'claude', '--model', 'umer-a', '--judge-agent', 'claude', '--judge-model', 'umer-b', '--dir', join(fresh, 'docs')], 2, { PATH: fakes });
  assert.match(readFileSync(join(evidence, 'init-one-agent-two-models.stderr'), 'utf8'), /^error: --model umer-a and --judge-model umer-b both set the model of claude, and agent_config holds one model per agent\nnext: learn-from-mistakes-axi init --agent claude --model <model> --judge-agent claude /m, 'two models for one agent do not state the one-model rule');
  run('init-one-agent-both-roles', process.execPath, [cli, 'init', '--no-skill', '--json', '--agent', 'claude', '--model', 'umer-a', '--judge-agent', 'claude', '--dir', join(fresh, 'docs')], 0, { PATH: fakes });
  assert.deepEqual(parse(readFileSync(join(fresh, 'docs', '.learn-from-mistakes.yaml'), 'utf8')).agent_config, { claude: { model: 'umer-a' } }, 'one agent in both roles did not save its one model');
  if (packageProof) {
    const pack = join(evidence, 'pack');
    mkdirSync(pack, { mode: 0o700 });
    run('npm-pack', 'npm', ['pack', '--pack-destination', pack]);
    const tarball = join(pack, readdirSync(pack).find((f) => f.endsWith('.tgz')));
    const manifest = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8' }).stdout.trim().split('\n');
    save('pack.manifest.txt', manifest.join('\n'));
    for (const f of ['bin/learn-from-mistakes-axi.mjs', 'src/config.mjs', 'src/metrics.mjs', 'src/followup.mjs', 'src/init.mjs', 'src/doctor.mjs', 'src/sources/markdown-log.mjs', 'src/sources/no-mistakes.mjs', 'src/sources/done-done.mjs', 'src/sources/firstmate.mjs', 'src/run.mjs', 'src/store.mjs',
      'src/runners/index.mjs', 'src/runners/byokit.mjs', 'src/runners/claude.mjs', 'src/runners/codex.mjs', 'src/runners/opencode.mjs', 'src/runners/pi.mjs', 'src/runners/gemini.mjs', 'src/runners/acp.mjs',
      'src/redact.mjs', 'src/sessions/claude.mjs', 'src/sessions/codex.mjs', 'src/sessions/opencode.mjs', 'src/sessions/pi.mjs', 'src/sessions/gemini.mjs', 'src/sources/sessions.mjs', 'src/bundle.mjs', 'src/sources/github.mjs', 'src/steps/agent-step.mjs', 'src/steps/analyse.mjs', 'src/prompts/analyse.md', 'src/steps/propose.mjs', 'src/prompts/propose.md', 'src/steps/verify.mjs', 'src/prompts/verify.md', 'src/check.mjs', 'src/signoff.mjs', 'package.json']) assert.ok(manifest.includes(`package/${f}`), `tarball omits ${f}`);
    assert.ok(manifest.some((f) => f.endsWith('skills/learn-from-mistakes/SKILL.md')), 'tarball omits the standalone skill');
    assert.ok(!manifest.some((f) => /^\s*package\/(test|examples)\//.test(f)), 'tarball bundles test/examples');
    const prefix = join(scratch, 'prefix');
    run('npm-install-pack', 'npm', ['install', '-g', '--prefix', prefix, tarball]);
    const installed = join(prefix, 'bin', 'learn-from-mistakes-axi');
    // README quick start with explicit synthetic user choices, through the installed CLI.
    // Reuse the real fixture runner processes; no credentials or sign-off peer are on PATH.
    const readme = readFileSync(join(repo, 'README.md'), 'utf8');
    for (const command of ['init --no-skill', 'doctor', 'retro --wait 8m', 'status', 'report', 'attach'])
      assert.ok(readme.includes(`learn-from-mistakes-axi ${command}`), `README omits ${command}`);
    assert.doesNotMatch(readme, /(?:labels|proposals)\.jsonl|--labels\b|--proposals\b|learn-from-mistakes-axi\s+(?:ingest|count)\b/, 'README teaches the removed manual flow');
    const quick = join(scratch, 'readme-project'), quickBin = join(scratch, 'readme-agents');
    mkdirSync(quick);
    mkdirSync(quickBin);
    for (const name of ['claude', 'codex', 'node', 'git']) symlinkSync(join(agentBin, name), join(quickBin, name));
    writeFileSync(join(quick, 'defects.md'), `## ${new Date().toISOString().slice(0, 10)}\n- Umer: the test command failed.\n`);
    const quickRun = (name, args, expected = 0, extra = {}) => run(`readme-${name}`, installed, [...args, '--dir', quick], expected, { PATH: quickBin, ...extra });
    quickRun('init-missing-choice', ['init', '--no-skill'], 2);
    assert.match(readFileSync(join(evidence, 'readme-init-missing-choice.stderr'), 'utf8'), /ask the user which agent to use/);
    assert.equal(parse(readFileSync(join(quick, '.learn-from-mistakes.yaml'), 'utf8')).agent, undefined, 'init chose an agent');
    quickRun('init', ['init', '--no-skill', '--agent', 'claude', '--model', 'umer-worker-model', '--judge-agent', 'codex', '--judge-model', 'umer-judge-model']);
    const quickConfig = join(quick, '.learn-from-mistakes.yaml');
    const choices = parse(readFileSync(quickConfig, 'utf8'));
    assert.deepEqual([choices.agent_config.claude.model, choices.agent_config.codex.model], ['umer-worker-model', 'umer-judge-model']);
    delete choices.agent_config.codex.model;
    writeFileSync(quickConfig, stringify(choices));
    quickRun('missing-model', ['retro', '--wait', '8m'], 2);
    assert.match(readFileSync(join(evidence, 'readme-missing-model.stderr'), 'utf8'), /ask the user which agent to use/);
    quickRun('save-model', ['init', '--no-skill', '--judge-agent', 'codex', '--judge-model', 'umer-judge-model']);
    quickRun('doctor', ['doctor']);
    assert.match(readFileSync(join(evidence, 'readme-doctor.stdout'), 'utf8'), /^warn sign-off /m);
    quickRun('retro', ['retro', '--wait', '8m', '--json'], 0, { LFM_TEST_SLOW_STEP: 'report:2000', FAKE_ANALYSE: 'label', FAKE_CAUSE: 'test-failed' });
    quickRun('status', ['status', '--json']);
    quickRun('attach', ['attach']);
    quickRun('report', ['report', '--json']);
    const quickReport = JSON.parse(readFileSync(join(evidence, 'readme-report.stdout'), 'utf8'));
    assert.equal(JSON.parse(readFileSync(join(evidence, 'readme-status.stdout'), 'utf8')).run.status, 'completed');
    assert.ok(inside(quick, quickReport.report_txt), 'README report escapes its project');
    const reportText = readFileSync(quickReport.report_txt, 'utf8');
    assert.match(reportText, /Questions for you/);
    save('readme-report.txt', reportText);
    quickRun('no-peer', ['signoff', 'answers']);
    assert.match(readFileSync(join(evidence, 'readme-no-peer.stdout'), 'utf8'), /No answers read: sign-off-axi is not installed/);
    // A short wait returning running is not a completed result; attach supplies the next step.
    quickRun('slow-retro', ['retro', '--wait', '1s', '--json'], 0, { LFM_TEST_SLOW_STEP: 'report:3000' });
    assert.equal(JSON.parse(readFileSync(join(evidence, 'readme-slow-retro.stdout'), 'utf8')).run.status, 'running');
    assert.match(readFileSync(join(evidence, 'readme-slow-retro.stderr'), 'utf8'), /next: .*attach .*still running/);
    quickRun('slow-attach', ['attach']);
    quickRun('slow-status', ['status', '--json']);
    assert.equal(JSON.parse(readFileSync(join(evidence, 'readme-slow-status.stdout'), 'utf8')).run.status, 'completed');
    run('packed-version', installed, ['--version']);
    run('packed-help', installed, ['--help']);
    run('packed-guide', installed, ['guide']);
    run('packed-agents', installed, ['agents', '--json'], 2); // no agent set: the packed bin also says to ask the user
    run('packed-report', installed, ['report', '--json', '--dir', staged]);
    assert.equal(JSON.parse(readFileSync(join(evidence, 'packed-report.stdout'), 'utf8')).schema, 'lfm-report.v2', 'packed bin does not drive the report');
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
    limitation: 'Review output against the journey manifests; trusted no-mistakes prompt consumption is a separate proof.' });
  if (existsSync(join(staged, '.lfm'))) cpSync(join(staged, '.lfm'), join(evidence, 'state'), { recursive: true }); // retain the run artifacts
  cleanupScratch();
  assert.deepEqual(after, before, 'Original inputs changed; proof fails');
}
console.log(`CLI commands and existing e2e suite passed. Review private evidence: ${evidence}`);
