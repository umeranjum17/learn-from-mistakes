#!/usr/bin/env node
// Public CLI proof; the existing three e2e journeys own behavioral assertions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { decode } from '@toon-format/toon';
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
  LFM_HOME: join(evidence, 'state'), npm_config_cache: join(scratch, 'npm-cache') };
const commands = [];
function run(name, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd: repo, env, encoding: 'utf8' });
  save(`${name}.stdout`, result.stdout ?? '');
  save(`${name}.stderr`, result.stderr ?? '');
  commands.push({ name, command, args, cwd: repo, status: result.status, error: result.error?.message });
  save('commands.json', commands);
  assert.equal(result.status, expected, `${name}: inspect private stderr/stdout logs`);
}
save('inputs.before.json', before);
save('identity.json', { repo, head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout,
  node: process.version, mode: mode ? 'private opt-in' : 'synthetic', inputs: before, sources, labels, proposals,
  candidate: ['bin/lfm.mjs', 'package.json', 'package-lock.json', 'test/cli.test.mjs', '.no-mistakes.yaml', 'CONSTRAINTS.md',
    '.agents/skills/verify-learn-from-mistakes/SKILL.md', '.agents/skills/verify-learn-from-mistakes/verify.mjs'].map(path =>
    ({ path, sha256: createHash('sha256').update(readFileSync(join(repo, path))).digest('hex') })) });
let passed = false;
try {
  const staged = join(scratch, 'project');
  config.name = 'verification'; // never let a caller config choose an output path
  for (const s of sources) {
    copyFileSync(s.path, join(staged, s.copy));
    config.sources[s.id].path = s.copy;
  }
  writeFileSync(join(staged, '.learn-from-mistakes.yaml'), stringify(config));
  copyFileSync(labels, join(staged, 'labels.jsonl'));
  copyFileSync(proposals, join(staged, 'proposals.jsonl'));
  // Reuse, don't duplicate, negative/duplicate/occurrence/unread journey coverage.
  run('npm-test', 'npm', ['test']);
  const cli = join(repo, 'bin/lfm.mjs');
  const stagedLabels = join(staged, 'labels.jsonl');
  const stagedProposals = join(staged, 'proposals.jsonl');
  const drive = (name, ...args) => run(name, process.execPath, [cli, ...args, '--dir', staged]);
  drive('help', '--help');    // help and version must work with no config read
  drive('version', '--version');
  drive('ingest', 'ingest');
  drive('bare', '--labels', stagedLabels, '--proposals', stagedProposals); // bare command = the report
  drive('count-unread', 'count');
  drive('count-labelled', 'count', '--labels', stagedLabels);
  drive('report', 'report', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-json', 'report', '--json', '--labels', stagedLabels, '--proposals', stagedProposals);
  drive('report-full', 'report', '--full', '--json', '--labels', stagedLabels, '--proposals', stagedProposals);
  // The default output is TOON; --json is the same projection under lfm-report.v1.
  const out = (name) => readFileSync(join(evidence, `${name}.stdout`), 'utf8');
  const toon = decode(out('bare'));
  assert.equal(toon.schema, 'lfm-report.v1', 'bare output is not valid TOON lfm-report.v1');
  assert.deepEqual(toon, JSON.parse(out('report-json')), '--json differs from the default projection');
  assert.ok(decode(out('report')).causes.length, 'report has no causes');
  const full = JSON.parse(out('report-full'));
  assert.ok(full.causes.every((c) => 'record_ids' in c && 'store_row_ids' in c), '--full omits evidence ids');
  assert.equal(out('version').trim(), JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version);
  // Privacy canary: private prose in a label and a proposal must never reach any output.
  const canary = 'CANARY-verify-private-1f4d';
  writeFileSync(stagedLabels, readFileSync(stagedLabels, 'utf8').replace('"why":"', `"why":"${canary} `));
  writeFileSync(stagedProposals, readFileSync(stagedProposals, 'utf8').replace('"change":"', `"change":"${canary} `));
  for (const extra of [[], ['--json'], ['--full', '--json']]) {
    const r = spawnSync(process.execPath, [cli, 'report', '--dir', staged, '--labels', stagedLabels, '--proposals', stagedProposals, ...extra], { cwd: repo, env, encoding: 'utf8' });
    commands.push({ name: `canary${extra.join('') || '-default'}`, command: process.execPath, args: [cli, 'report', ...extra], cwd: repo, status: r.status });
    save(`canary${extra.join('') || '-default'}.stdout`, r.stdout ?? '');
    assert.equal(r.status, 0, 'canary report failed');
    assert.ok(!r.stdout.includes(canary) && !(r.stderr ?? '').includes(canary), 'private canary text reached the output');
  }
  save('canary.json', { canary, absentFrom: ['default', '--json', '--full'] });
  if (packageProof) {
    const pack = join(evidence, 'pack');
    mkdirSync(pack, { mode: 0o700 });
    run('npm-pack', 'npm', ['pack', '--pack-destination', pack]);
    const tarball = join(pack, readdirSync(pack).find((f) => f.endsWith('.tgz')));
    const manifest = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8' }).stdout.trim().split('\n');
    save('pack.manifest.txt', manifest.join('\n'));
    assert.ok(manifest.includes('package/bin/lfm.mjs') && manifest.includes('package/package.json'), 'tarball omits the bin or package.json');
    assert.ok(manifest.some((f) => f.endsWith('skills/learn-from-mistakes/SKILL.md')), 'tarball omits the standalone skill');
    assert.ok(!manifest.some((f) => /^\s*package\/(test|examples)\//.test(f)), 'tarball bundles test/examples');
    const prefix = join(scratch, 'prefix');
    run('npm-install-pack', 'npm', ['install', '-g', '--prefix', prefix, tarball]);
    const installed = join(prefix, 'bin', 'lfm');
    run('packed-version', installed, ['--version']);
    run('packed-help', installed, ['--help']);
    run('packed-report', installed, ['report', '--json', '--dir', staged, '--labels', stagedLabels, '--proposals', stagedProposals]);
    assert.equal(JSON.parse(readFileSync(join(evidence, 'packed-report.stdout'), 'utf8')).schema, 'lfm-report.v1', 'packed bin does not drive the report');
    assert.ok(existsSync(join(prefix, 'lib', 'node_modules', 'learn-from-mistakes', 'skills', 'learn-from-mistakes', 'SKILL.md')), 'packaged standalone skill is missing');
    save('pack.json', { tarball: tarball.slice(evidence.length + 1), sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'), files: manifest.length });
  }
  passed = true;
} finally {
  const after = hashes();
  save('inputs.after.json', after);
  save('result.json', { commandsPassed: passed, inputsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    limitation: 'Review output against the skill feature map; trusted no-mistakes prompt consumption is a separate proof.' });
  rmSync(scratch, { recursive: true, force: true });
  assert.deepEqual(after, before, 'Original inputs changed; proof fails');
}
console.log(`CLI commands and existing e2e suite passed. Review private evidence: ${evidence}`);
