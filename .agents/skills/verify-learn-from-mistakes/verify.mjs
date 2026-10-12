#!/usr/bin/env node
// Public CLI proof; the existing e2e journeys own behavioral assertions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
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
  npm_config_cache: join(scratch, 'npm-cache') };
delete env.LFM_CLI; // only packed-npm-test points the journeys at another bin
delete env.LFM_HOME; // no global config: the CLI keeps state in the staged project's own .lfm/
delete env.CLAUDE_CONFIG_DIR; // the sessions drive reads only the synthetic store in the scratch HOME
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
  candidate: ['bin/learn-from-mistakes-axi.mjs', 'src/config.mjs', 'src/sources/markdown-log.mjs', 'src/sources/no-mistakes.mjs', 'src/run.mjs', 'src/store.mjs',
    'src/redact.mjs', 'src/sessions/claude.mjs', 'src/sources/sessions.mjs', 'package.json', 'package-lock.json', 'scripts/build-skill.mjs', 'skills/learn-from-mistakes/SKILL.md', 'test/cli.test.mjs', 'test/sessions.test.mjs', '.no-mistakes.yaml', 'CONSTRAINTS.md',
    '.agents/skills/verify-learn-from-mistakes/SKILL.md', '.agents/skills/verify-learn-from-mistakes/verify.mjs'].map(path =>
    ({ path, sha256: createHash('sha256').update(readFileSync(join(repo, path))).digest('hex') })) });
let passed = false;
const staged = join(scratch, 'project');
try {
  config.name = 'verification'; // never let a caller config choose an output path
  for (const s of sources) {
    copyFileSync(s.path, join(staged, s.copy));
    config.sources[s.id].path = s.copy;
  }
  writeFileSync(join(staged, '.learn-from-mistakes.yaml'), stringify(config));
  copyFileSync(labels, join(staged, 'labels.jsonl'));
  copyFileSync(proposals, join(staged, 'proposals.jsonl'));
  // Reuse, don't duplicate, negative/duplicate/occurrence/unread journey coverage.
  run('npm-test', 'npm', ['test', '--ignore-scripts']);
  const cli = join(repo, 'bin/learn-from-mistakes-axi.mjs');
  const stagedLabels = join(staged, 'labels.jsonl');
  const stagedProposals = join(staged, 'proposals.jsonl');
  const drive = (name, ...args) => run(name, process.execPath, [cli, ...args, '--dir', staged]);
  run('guide', process.execPath, [cli, 'guide']); // the agent procedure, no project config needed
  drive('ingest', 'ingest');
  drive('bare', '--labels', stagedLabels, '--proposals', stagedProposals); // bare command = the report
  drive('count-unread', 'count');
  drive('count-labelled', 'count', '--labels', stagedLabels);
  if (!mode) { // the synthetic config names the cause; a private run never records a change
    drive('changes-empty', 'changes', '--json'); // config only, before any change
    drive('change-applied', 'change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', '--at', '2026-01-02T03:04:05Z',
      '--what', 'Run builds in their own memory group', '--why', 'The memory killer stopped the server three times', '--json');
    drive('changes', 'changes');
    drive('changes-json', 'changes', '--json');
  }
  drive('report', 'report', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-detail', 'report', '--full', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-json', 'report', '--json', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-full', 'report', '--full', '--json', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('retro', 'retro', '--foreground'); // a saved run in the staged .lfm/lfm.sqlite
  drive('retro-wait', 'retro', '--wait', '1m'); // the same run in a detached worker, waited for
  drive('status', 'status');
  drive('runs', 'runs');
  // Config v2: every new key loads and the run completes the same steps; a bad runner exits 2 naming the key.
  const stagedConfig = join(staged, '.learn-from-mistakes.yaml');
  Object.assign(config, { worker: { runner: 'auto', model: '' }, judge: { runner: 'acp:gemini', model: 'cheap-model' }, window: '7d',
    targets: { first_pass: '>= 70', escaped: '<= 0' }, followup: { min_sessions: 3, min_days: 2 }, excerpts: 'off',
    caps: { invocations: 12, bundle_chars: 60000, timeout: '20m' }, signoff: 'auto', allow_premium: false });
  writeFileSync(stagedConfig, stringify(config));
  drive('retro-v2', 'retro', '--foreground', '--json');
  writeFileSync(stagedConfig, stringify({ ...config, worker: { runner: 3 } }));
  run('config-bad-runner', process.execPath, [cli, 'retro', '--foreground', '--dir', staged], 2);
  // Sessions: one synthetic Claude Code session in the scratch HOME, run in the staged project, with a failed test.
  const store = join(env.HOME, '.claude', 'projects', 'staged');
  mkdirSync(store, { recursive: true });
  const at = { cwd: staged, sessionId: 's-verify', timestamp: '2026-10-12T09:00:00.000Z' };
  writeFileSync(join(store, 's-verify.jsonl'), [
    { type: 'user', ...at, message: { role: 'user', content: 'Umer: run the tests.' } },
    { type: 'assistant', ...at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', ...at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(stagedConfig, stringify({ ...config, sources: { ...config.sources, sessions: { type: 'sessions' } } }));
  drive('retro-sessions', 'retro', '--foreground', '--json');
  const read = JSON.parse(readFileSync(join(evidence, 'retro-sessions.stdout'), 'utf8')).sources.find((s) => s.type === 'sessions');
  assert.ok(read.sessions === 1 && read.metrics.tool_error_rate === 1, 'the sessions source does not read the synthetic session');
  writeFileSync(stagedConfig, stringify(config));
  if (packageProof) {
    const pack = join(evidence, 'pack');
    mkdirSync(pack, { mode: 0o700 });
    run('npm-pack', 'npm', ['pack', '--pack-destination', pack]);
    const tarball = join(pack, readdirSync(pack).find((f) => f.endsWith('.tgz')));
    const manifest = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8' }).stdout.trim().split('\n');
    save('pack.manifest.txt', manifest.join('\n'));
    for (const f of ['bin/learn-from-mistakes-axi.mjs', 'src/config.mjs', 'src/sources/markdown-log.mjs', 'src/sources/no-mistakes.mjs', 'src/run.mjs', 'src/store.mjs',
      'src/redact.mjs', 'src/sessions/claude.mjs', 'src/sources/sessions.mjs', 'package.json']) assert.ok(manifest.includes(`package/${f}`), `tarball omits ${f}`);
    assert.ok(manifest.some((f) => f.endsWith('skills/learn-from-mistakes/SKILL.md')), 'tarball omits the standalone skill');
    assert.ok(!manifest.some((f) => /^\s*package\/(test|examples)\//.test(f)), 'tarball bundles test/examples');
    const prefix = join(scratch, 'prefix');
    run('npm-install-pack', 'npm', ['install', '-g', '--prefix', prefix, tarball]);
    const installed = join(prefix, 'bin', 'learn-from-mistakes-axi');
    run('packed-version', installed, ['--version']);
    run('packed-help', installed, ['--help']);
    run('packed-guide', installed, ['guide']);
    run('packed-report', installed, ['report', '--json', '--dir', staged, '--labels', stagedLabels, '--proposals', stagedProposals]);
    assert.equal(JSON.parse(readFileSync(join(evidence, 'packed-report.stdout'), 'utf8')).schema, 'lfm-report.v1', 'packed bin does not drive the report');
    if (!mode) {
      run('packed-changes', installed, ['changes', '--json', '--dir', staged]);
      assert.equal(JSON.parse(readFileSync(join(evidence, 'packed-changes.stdout'), 'utf8')).schema, 'lfm-changes.v1', 'packed bin does not drive the export');
    }
    run('packed-retro', installed, ['retro', '--wait', '1m', '--json', '--dir', staged]); // the installed bin spawns its own worker
    const packedRun = JSON.parse(readFileSync(join(evidence, 'packed-retro.stdout'), 'utf8'));
    assert.ok(packedRun.run.status === 'completed' && packedRun.steps.length === 2, 'packed bin does not complete a detached run');
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
  rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(after, before, 'Original inputs changed; proof fails');
}
console.log(`CLI commands and existing e2e suite passed. Review private evidence: ${evidence}`);
