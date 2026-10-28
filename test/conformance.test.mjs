// Conformance: every command and worked example the skill (skills/lfm-retro/SKILL.md) and the README show
// runs as written, from a fresh packed install, and every guard refuses bad input with `error:` + `next:`, never a
// stack trace and never a broken-citation message for a missing evidence file. Integration style: it drives the real
// CLI, like cli.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { SIGNOFF_MIN } from '../src/signoff.mjs';

const REPO = new URL('..', import.meta.url).pathname;
const CLI = process.env.LFM_CLI || join(REPO, 'bin', 'learn-from-mistakes-axi.mjs');
const FAKE = new URL('fake-agent/claude', import.meta.url).pathname;
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';
const STACK = /\n\s+at [^\n]*:\d+:\d+/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

// A project holding the examples with a defect log dated now, its own state and a throwaway global agent config.
// HOME and SIGN_OFF_HOME point at a private folder, so a sign-off-axi on the host PATH reads and locks a private board, never the host's.
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
  const user = join(tmp, 'user');
  mkdirSync(user);
  const env = { ...process.env, PATH: `${fakes}${delimiter}${process.env.PATH}`, LFM_HOME: home, HOME: user, SIGN_OFF_HOME: user,
    TMPDIR: tmp, LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: tmp, GIT_CEILING_DIRECTORIES: tmpdir() };
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
  const docs = ['skills/lfm-retro/SKILL.md', 'README.md'].map((f) => readFileSync(join(REPO, f), 'utf8')).join('\n');
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

// Conformance to the sign-off contract v1 for the one kind this repo sends (finding, schema 1): the released
// sign-off-axi this repo pins validates the fixtures in both directions and accepts a message in the adapter's
// exact emitted shape (src/signoff.mjs). Integration style: the real peer CLI, installed fresh like the drive above.
test('the finding fixtures pass the pinned sign-off-axi validate, and the invalid ones are refused', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-contract-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const peer = join(tmp, 'peer');
  const install = spawnSync('npm', ['install', '--prefix', peer, `sign-off-axi@${SIGNOFF_MIN}`, '--no-audit', '--no-fund'], { encoding: 'utf8' });
  assert.equal(install.status, 0, install.stderr);
  const validate = (...args) => spawnSync(join(peer, 'node_modules', '.bin', 'sign-off-axi'), ['validate', ...args], { encoding: 'utf8' });
  const dir = join(REPO, 'test', 'fixtures', 'contract', 'finding.v1');
  const files = readdirSync(dir).map((f) => join(dir, f));
  const valid = files.filter((f) => f.slice(f.lastIndexOf('/') + 1).startsWith('valid-'));
  const invalid = files.filter((f) => f.slice(f.lastIndexOf('/') + 1).startsWith('invalid-'));
  assert.ok(valid.length >= 2 && invalid.length >= 3, 'the contract fixtures hold at least 2 valid and 3 invalid finding messages');
  const good = validate('--kind', 'finding', ...valid);
  assert.equal(good.status, 0, `the pinned peer refuses a valid fixture:\n${good.stdout}`);
  assert.doesNotMatch(good.stdout, /,false,/, `a valid fixture was refused:\n${good.stdout}`);
  const refused = validate('--kind', 'finding', '--expect-invalid', ...invalid);
  assert.equal(refused.status, 0, `the pinned peer accepts an invalid fixture:\n${refused.stdout}`);
  for (const [file, rule] of [
    ['invalid-cause-missing.json', /cause is required/],
    ['invalid-proposal-too-long.json', /proposal is \d+ characters, over 500/],
    ['invalid-record_text-unknown.json', /record_text is not a field of finding schema 1/],
  ]) {
    const r = validate('--kind', 'finding', join(dir, file));
    assert.equal(r.status, 2, `${file}: expected a refusal, got exit ${r.status}\n${r.stdout}`);
    assert.match(r.stdout, rule, `${file}: the refusal does not name the rule its name gives:\n${r.stdout}`);
  }
  // One message in the adapter's emitted shape, written to a temp file: the peer accepts it.
  writeFileSync(join(tmp, 'finding.json'), JSON.stringify({
    contract: 1, kind: 'finding', schema: 1, key: 'lfm-7-3-1c4e7a90', title: 'Repeated cause: agent-exit-wait', filer: 'learn-from-mistakes',
    about: '6 incidents over 4 days.', cause: 'agent-exit-wait', incidents: 6, days: 4, evidence_ids: ['rec-4d21', 'e88'],
    change_kind: 'rule', proposal: 'Stop the agent by its process group at the timeout, never by a fixed sleep.',
    options: [{ value: 'apply', label: 'Apply' }, { value: 'skip', label: 'Skip' }], recommend_value: 'apply',
  }));
  assert.equal(validate(join(tmp, 'finding.json')).status, 0, 'the pinned peer refuses a message in the adapter\'s emitted shape');
});
