// Conformance: every command and worked example the skill (skills/learn-from-mistakes/SKILL.md) and the README show
// runs as written, from a fresh packed install, and every guard refuses bad input with `error:` + `next:`, never a
// stack trace and never a broken-citation message for a missing evidence file. Integration style: it drives the real
// CLI, like cli.test.mjs.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { once } from 'node:events';
import { after, test } from 'node:test';

const REPO = new URL('..', import.meta.url).pathname;
const CLI = process.env.LFM_CLI || join(REPO, 'bin', 'learn-from-mistakes-axi.mjs');
const FAKE = new URL('fake-agent/claude', import.meta.url).pathname;
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';
const STACK = /\n\s+at [^\n]*:\d+:\d+/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// A project holding the examples with a defect log dated now, its own state and a throwaway global agent config.
function project() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-conformance-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'p');
  mkdirSync(p);
  writeFileSync(join(p, 'defects.md'), `## ${new Date().toISOString().slice(0, 10)}\n- Umer: the test command failed.\n- Umer: the test command failed again.\n- Umer: the build command failed.\n`);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources: { log: { type: markdown-log, path: defects.md } }\n');
  const fakes = join(tmp, 'fakes');
  mkdirSync(fakes);
  for (const name of ['claude', 'codex']) symlinkSync(FAKE, join(fakes, name));
  const home = join(tmp, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.yaml'), AGENTS_SET);
  const env = { ...process.env, PATH: `${fakes}${delimiter}${process.env.PATH}`, LFM_HOME: home, GIT_CEILING_DIRECTORIES: tmpdir() };
  const lfm = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, ...extra } });
  const write = (text) => writeFileSync(join(p, '.learn-from-mistakes.yaml'), text);
  return { tmp, p, env, lfm, write };
}

// The uniform refusal contract: a nonzero exit, an `error:` line, a `next:` line, and no stack trace.
function refuses(result, why) {
  assert.notEqual(result.status, 0, `${why}: expected a refusal, got exit 0\n${result.stdout}`);
  assert.match(result.stderr, /^error: /m, `${why}: no error: line\n${result.stderr}`);
  assert.match(result.stderr, /^next: /m, `${why}: no next: line\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, STACK, `${why}: a stack trace reached the user\n${result.stderr}`);
}

test('every command the skill and README show is a real command the CLI accepts', () => {
  const docs = ['skills/learn-from-mistakes/SKILL.md', 'README.md'].map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
  const commands = new Set([...docs.matchAll(/learn-from-mistakes-axi (?:-y )?((?:change applied|signoff (?:post|answers)|[a-z][a-z-]*))/g)].map((m) => m[1]));
  assert.ok(commands.has('init') && commands.has('retro') && commands.has('report'), 'the docs no longer show the core commands');
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-conformance-docs-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  for (const command of commands) {
    const r = spawnSync(process.execPath, [CLI, ...command.split(' '), '--dir', tmp], { encoding: 'utf8' });
    assert.doesNotMatch(r.stderr, /unknown command/, `the docs show "${command}", which the CLI does not accept\n${r.stderr}`);
  }
});

test('the skill command sequence runs as written from a fresh packed install', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-conformance-pack-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const pack = join(tmp, 'pack');
  mkdirSync(pack);
  const packed = spawnSync('npm', ['pack', '--pack-destination', pack], { cwd: REPO, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = join(pack, readdirSync(pack).find((f) => f.endsWith('.tgz')));
  const prefix = join(tmp, 'prefix');
  const installed = spawnSync('npm', ['install', '-g', '--prefix', prefix, tarball], { encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr);
  const bin = join(prefix, 'bin', 'learn-from-mistakes-axi');
  const { p, env } = project();
  const run = (name, args, expected = 0, extra = {}, withDir = true) => {
    const r = spawnSync(bin, withDir ? [...args, '--dir', p] : args, { encoding: 'utf8', env: { ...env, ...extra } });
    assert.equal(r.status, expected, `${name}: ${r.stderr || r.stdout}`);
    assert.doesNotMatch(r.stderr, STACK, `${name}: a stack trace reached the user\n${r.stderr}`);
    return r;
  };
  run('guide', ['guide'], 0, {}, false);
  run('help', ['--help'], 0, {}, false);
  run('version', ['--version'], 0, {}, false);
  run('init', ['init', '--no-skill', '--agent', 'claude', '--model', 'claude-haiku-5-5', '--judge-agent', 'codex', '--judge-model', 'gpt-6-luna']);
  run('doctor', ['doctor']);
  run('retro', ['retro', '--wait', '8m', '--json'], 0, { FAKE_ANALYSE: 'label', LFM_TEST_SLOW_STEP: 'report:1500' });
  run('status', ['status', '--json']);
  run('attach', ['attach']);
  const report = run('report', ['report', '--json']);
  run('runs', ['runs', '--json']);
  run('logs', ['logs', '--step', 'analyse', '--json']);
  run('changes', ['changes', '--json']);
  run('agents', ['agents', '--json']);
  run('signoff-answers', ['signoff', 'answers']);
  const out = JSON.parse(report.stdout);
  assert.equal(out.schema, 'lfm-report.v2', 'the packed report is not lfm-report.v2');
  assert.ok(out.report_txt.startsWith(p) && existsSync(out.report_txt), 'the packed report_txt is missing or escapes the project');
  assert.match(readFileSync(out.report_txt, 'utf8'), /Questions for you/);
});

test('every guard refuses bad input with error: and next:, never a stack trace', () => {
  const { lfm, write } = project();
  for (const [why, args] of [
    ['an unknown command', ['frobnicate']],
    ['an unknown option', ['--bogus']],
    ['an unknown --run', ['status', '--run', '99']],
    ['a bad --run id', ['status', '--run', 'abc']],
    ['a bad --wait', ['retro', '--wait', 'soon']],
    ['a bad --step', ['logs', '--step', 'bogus']],
    ['a missing --cause', ['change', 'applied', '--ref', 'abc1234']],
    ['a bad --ref', ['change', 'applied', '--cause', 'gate-failure', '--ref', 'nope']],
    ['a bad --tripwire', ['change', 'applied', '--cause', 'gate-failure', '--ref', 'abc1234', '--tripwire', '< x']],
    ['a bad --kind', ['change', 'applied', '--cause', 'gate-failure', '--ref', 'abc1234', '--kind', 'bogus']],
    ['no run to inspect', ['report']],
    ['no run to apply', ['apply', '--run', '99']],
  ]) refuses(lfm(args), why);
  for (const [why, config] of [
    ['an unknown config key', 'unknown_key: 1\nsources: { log: { type: markdown-log, path: defects.md } }\n'],
    ['a bad source type', 'sources: { log: { type: nope, path: defects.md } }\n'],
    ['a source with no path', 'sources: { log: { type: markdown-log } }\n'],
    ['a bad window', 'window: bogus\nsources: { log: { type: markdown-log, path: defects.md } }\n'],
    ['bad caps', 'caps: { invocations: -1 }\nsources: { log: { type: markdown-log, path: defects.md } }\n'],
    ['an agent that is not a name', 'agent: 3\nsources: { log: { type: markdown-log, path: defects.md } }\n'],
  ]) { write(config); refuses(lfm(['retro', '--foreground']), why); }
  const { p, lfm: lfm2 } = project(); // a source file that went missing is named, with the fix
  rmSync(join(p, 'defects.md'));
  const gone = lfm2(['retro', '--foreground', '--json']);
  assert.equal(gone.status, 1, gone.stderr);
  assert.match(JSON.parse(gone.stdout).run.error, /source log: cannot read \(ENOENT\)/);
  assert.doesNotMatch(gone.stderr, STACK);
});

test('a missing run evidence file names the file and the fix, never a broken citation', async () => {
  const { p, env } = project();
  const bundle = () => join(p, '.lfm', 'runs', '1', 'bundle.md');
  const child = spawn(process.execPath, [CLI, 'retro', '--wait', '2m', '--json', '--dir', p],
    { env: { ...env, FAKE_ANALYSE: 'label', LFM_TEST_SLOW_STEP: 'analyse:4000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 400 && !existsSync(bundle()); i++) await sleep(25); // the bundle step writes it before analyse sleeps
  assert.ok(existsSync(bundle()), 'the run never wrote its bundle.md');
  rmSync(bundle()); // the evidence file briefly went missing
  await once(child, 'exit');
  const run = JSON.parse(out).run;
  assert.equal(run.status, 'failed');
  assert.match(run.error, /bundle .*bundle\.md is missing/);
  assert.doesNotMatch(run.error, /bundle item/, 'a missing evidence file was blamed on the citation');
  assert.doesNotMatch(err, STACK, 'a missing evidence file ended in a stack trace');
  assert.doesNotMatch(readFileSync(join(p, '.lfm', 'runs', '1', 'worker.log'), 'utf8'), STACK);
});
