// End-to-end: the real CLI starts fake claude, codex and opencode binaries (PATH holds only them) in a copy of the
// examples, with a throwaway HOME and LFM_HOME. Each fake records its argv, cwd, stdin and env, then answers like its agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const MODELS = JSON.parse(readFileSync(new URL('../src/models.json', import.meta.url), 'utf8'));
const SECRET = 'CANARY-login-secret-5d1e';
// FAKE_<RUNNER>: ok (default), broken (--version exits 1), hang, grandchild (holds stdout after exit), write, flaky (529 once),
// prose (answers in plain text, no JSON), error (claude's own is_error result), empty-error (claude's is_error result with no text), stale (codex writes its answer then 529s; the retry writes nothing).
const FAKE = `
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const name = path.basename(process.argv[1]), args = process.argv.slice(2), mode = process.env['FAKE_' + name.toUpperCase()] || 'ok';
if (args[0] === '--version') { if (mode === 'broken') { console.error('No version is set for shim: ' + name); process.exit(1); } console.log('1.2.3 (fake ' + name + ')'); process.exit(0); }
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const log = path.join(process.env.FAKE_LOG, name + '.jsonl');
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), stdin, permission: process.env.OPENCODE_PERMISSION ?? null }) + '\\n');
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const once = path.join(process.env.FAKE_LOG, name + '.flaky');
  if (mode === 'flaky' && !fs.existsSync(once)) { fs.writeFileSync(once, ''); console.error('API Error: 529 overloaded'); process.exit(1); }
  if (mode === 'stale' && !fs.existsSync(once)) { fs.writeFileSync(once, ''); fs.writeFileSync(args[args.indexOf('-o') + 1], 'stale answer'); console.error('API Error: 529 overloaded'); process.exit(1); }
  if (mode === 'write') fs.writeFileSync('x.txt', 'ok');
  if (mode === 'grandchild') spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
  const text = mode === 'prose' ? 'I cannot create x.txt: my tools are off.' : JSON.stringify({ reply: 'hello from ' + name });
  if (name === 'claude') console.log(JSON.stringify({ type: 'result', is_error: mode === 'error' || mode === 'empty-error', result: mode === 'empty-error' ? undefined : mode === 'error' ? "The model's tool call could not be parsed" : text }));
  if (name === 'codex') { if (mode !== 'stale') fs.writeFileSync(args[args.indexOf('-o') + 1], 'Done:\\n\`\`\`json\\n' + text + '\\n\`\`\`\\n'); console.log('tokens used: 10'); }
  if (name === 'opencode') console.log(JSON.stringify({ type: 'text', part: { text: 'thinking' } }) + '\\n' + JSON.stringify({ type: 'text', part: { text } }));
}
`;

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-run-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'p'), bin = join(tmp, 'bin'), log = join(tmp, 'log'), home = join(tmp, 'home');
  cpSync(new URL('../examples', import.meta.url).pathname, p, { recursive: true });
  for (const d of [bin, log, join(home, '.claude')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), SECRET); // codex and opencode stay logged out
  for (const name of ['claude', 'codex', 'opencode']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${FAKE}`);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { PATH: bin, HOME: home, LFM_HOME: join(tmp, 'lfm-home'), FAKE_LOG: log, XDG_DATA_HOME: join(home, 'data') };
  const lfm = (extra, ...args) => {
    const t = Date.now();
    const r = spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, ...extra } });
    return { ...r, secs: (Date.now() - t) / 1000 };
  };
  const calls = (name) => (existsSync(join(log, `${name}.jsonl`)) ? readFileSync(join(log, `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const config = (extra) => writeFileSync(join(p, '.learn-from-mistakes.yaml'), readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8') + extra);
  return { tmp, p, env, lfm, calls, config };
}

test('agents lists each agent CLI with version, login presence and default model; a broken shim is not usable', () => {
  const { lfm, tmp } = setup();
  const r = lfm({ FAKE_CODEX: 'broken' }, 'agents', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const by = Object.fromEntries(out.agents.map((a) => [a.runner, a]));
  assert.deepEqual(Object.keys(by), ['claude', 'codex', 'opencode']);
  assert.equal(by.claude.usable, true);
  assert.equal(by.claude.version, '1.2.3');
  assert.equal(by.claude.login, '.credentials.json'); // the file name only, never its contents
  assert.equal(by.opencode.login, 'not found (it may be in the system keychain)');
  assert.equal(by.codex.usable, false);
  assert.match(by.codex.problem, /--version failed: No version is set for shim: codex/);
  for (const a of out.agents) assert.equal(a.model, MODELS[a.runner][0]); // defaults come from src/models.json
  assert.deepEqual([by.claude.tools, by.codex.tools, by.opencode.tools], ['off', 'read-only', 'off']);
  assert.deepEqual(out.worker, { runner: 'claude', model: MODELS.claude[0], bin: join(tmp, 'bin', 'claude'), problem: '' });
  assert.equal(out.judge.runner, 'opencode'); // the first usable identity that differs from the worker's
  assert.ok(!(r.stdout + r.stderr).includes('CANARY'), 'login contents never print');
  assert.match(r.stderr, /^next: learn-from-mistakes-axi agents --test claude/m);

  const own = lfm({ LFM_MODEL: 'gpt-6-luna' }, 'agents'); // a listed model moves the auto worker to the CLI that lists it
  assert.equal(own.status, 0, own.stderr);
  const toon = decode(own.stdout);
  assert.deepEqual(toon.agents.map((a) => [a.runner, a.model]), [['claude', MODELS.claude[0]], ['codex', 'gpt-6-luna'], ['opencode', MODELS.opencode[0]]]);
  assert.equal(toon.worker.runner, 'codex');
  assert.equal(toon.worker.model, 'gpt-6-luna');

  const unlisted = lfm({ LFM_MODEL: 'my-own-model' }, 'agents'); // no default list has it, so auto cannot pair it with a runner
  assert.equal(unlisted.status, 1);
  assert.match(unlisted.stderr, /^problem: worker: no usable agent CLI lists model my-own-model$/m);
  assert.match(unlisted.stderr, /^next: set worker\.runner in \.learn-from-mistakes\.yaml to a usable agent CLI/m);
});

test('an auto judge model binds to the runner that lists it, so it cannot clash with the worker unseen', () => {
  const { lfm, config, tmp } = setup();
  mkdirSync(join(tmp, 'lfm-home'));
  writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), `runner_path: { opencode: ${join(tmp, 'no-such-opencode')} }\n`); // only claude and codex usable
  config('judge: { model: claude-haiku-5-5 }\n');
  const r = lfm({}, 'agents', '--json');
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.worker.runner, 'claude');
  assert.equal(out.judge.runner, 'claude');
  assert.match(out.judge.problem, /would judge its own work/);
});

test('the judge never resolves to the worker: a clash exits 1 with the fix', () => {
  const { lfm, config } = setup();
  config('worker: { runner: claude, model: claude-haiku-5-5 }\njudge: { runner: claude }\n');
  const r = lfm({}, 'agents', '--json');
  assert.equal(r.status, 1, r.stderr);
  assert.match(JSON.parse(r.stdout).judge.problem, /would judge its own work/);
  assert.match(r.stderr, /^problem: judge: the judge resolves to the worker's agent and model/m);
  assert.match(r.stderr, /^next: set judge\.runner and judge\.model in \.learn-from-mistakes\.yaml to an agent CLI and a different model, or install a second agent CLI$/m);
  const two = lfm({ LFM_MODEL: 'cheap-a' }, 'agents', '--json'); // a pinned worker keeps its model, so it differs from the judge's
  assert.equal(two.status, 0, two.stderr);
});

test('agents --test starts each runner tool-off in its run dir, with the marker first and the runner default model', () => {
  const { p, lfm, calls, config, tmp } = setup();
  mkdirSync(join(tmp, 'lfm-home'));
  writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), 'runner_args: { codex: [--ignore-rules] }\n');
  config('caps: { timeout: 30s }\n');
  for (const runner of ['claude', 'codex', 'opencode']) {
    const r = lfm({}, 'agents', '--test', runner, '--json');
    assert.equal(r.status, 0, r.stderr);
    const dir = join(p, '.lfm', 'runs', `test-${runner}`);
    assert.deepEqual(JSON.parse(r.stdout).test, { runner, model: MODELS[runner][0], tools: runner === 'codex' ? 'read-only' : 'off', dir,
      reply: `hello from ${runner}` });
    const [c] = calls(runner);
    assert.equal(c.cwd, dir);
    assert.ok(!existsSync(join(dir, 'x.txt')));
  }
  const [cl] = calls('claude'), [cx] = calls('codex'), [oc] = calls('opencode');
  const run = (r) => join(p, '.lfm', 'runs', `test-${r}`);
  assert.deepEqual(cl.args, ['-p', '--output-format', 'json', '--model', MODELS.claude[0], '--tools', '', '--no-session-persistence', '--strict-mcp-config']);
  assert.match(cl.stdin, /^lfm-run:test:claude\nThis tests that your tools are off/);
  assert.deepEqual(cx.args, ['exec', '-m', MODELS.codex[0], '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-o', join(run('codex'), 'out-codex.txt'), '-']);
  assert.match(cx.stdin, /^lfm-run:test:codex\n/);
  assert.deepEqual(oc.args, ['run', '-m', MODELS.opencode[0], '--format', 'json', '--dir', run('opencode'), '-f', join(run('opencode'), 'prompt-opencode.md'),
    '--', 'lfm-run:test:opencode Follow the instructions in the attached file.']);
  assert.equal(oc.permission, '{"*":"deny"}');
  assert.match(readFileSync(join(run('opencode'), 'prompt-opencode.md'), 'utf8'), /^lfm-run:test:opencode\nThis tests that your tools are off/);
  assert.deepEqual(readdirSync(join(p, '.lfm')).sort(), ['.gitignore', 'runs']);
});

test('no default model is premium: the models table, the agents listing and the guide stay cheap', () => {
  const { lfm, env, p } = setup();
  const premium = /opus|sonnet|\bsol\b/i;
  for (const model of Object.values(MODELS).flat()) assert.doesNotMatch(model, premium);
  const listed = lfm({}, 'agents', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  for (const a of JSON.parse(listed.stdout).agents) assert.doesNotMatch(a.model, premium);
  const guide = (extra) => spawnSync(process.execPath, [CLI, 'guide'], { encoding: 'utf8', cwd: p, env: { ...env, ...extra } });
  const dflt = guide({});
  assert.equal(dflt.status, 0, dflt.stderr);
  for (const line of dflt.stdout.split('\n')) if (premium.test(line)) assert.match(line, /never/i, `the guide takes a premium model as a default: ${line}`);
  const own = guide({ LFM_MODEL: 'my-own-model' });
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /my-own-model \(LFM_MODEL\)/);
});

test('a hung, leaking, writing or overloaded agent ends with its real cause', () => {
  const { lfm, calls, config, p } = setup();
  config('caps: { timeout: 2s }\n');
  const hang = lfm({ FAKE_CLAUDE: 'hang' }, 'agents', '--test', 'claude');
  assert.equal(hang.status, 1);
  assert.match(hang.stderr, /^error: claude: no answer within 2s in one attempt; stopped it \(caps\.timeout\)$/m);
  assert.ok(hang.secs < 8, `killed at the timeout, took ${hang.secs}s`);

  const leak = lfm({ FAKE_CODEX: 'grandchild' }, 'agents', '--test', 'codex'); // a grandchild keeps stdout open
  assert.equal(leak.status, 0, leak.stderr);
  assert.ok(leak.secs < 9, `returned within the 5 s pipe wait, took ${leak.secs}s`);

  const write = lfm({ FAKE_OPENCODE: 'write' }, 'agents', '--test', 'opencode');
  assert.equal(write.status, 1);
  assert.match(write.stderr, /^error: opencode wrote x\.txt in its run dir .*: its tools are not off$/m);
  assert.ok(existsSync(join(p, '.lfm', 'runs', 'test-opencode', 'x.txt')));

  const prose = lfm({ FAKE_OPENCODE: 'prose' }, 'agents', '--test', 'opencode', '--json'); // no JSON, nothing written: passes
  assert.equal(prose.status, 0, prose.stderr);
  assert.equal(JSON.parse(prose.stdout).test.reply, 'I cannot create x.txt: my tools are off.');
  const own = lfm({ FAKE_CLAUDE: 'error' }, 'agents', '--test', 'claude'); // the agent's own error stays a failure
  assert.equal(own.status, 1);
  assert.match(own.stderr, /^error: claude: The model's tool call could not be parsed$/m);

  const flaky = lfm({ FAKE_CLAUDE: 'flaky' }, 'agents', '--test', 'claude', '--json'); // 529 once, then an answer
  assert.equal(flaky.status, 0, flaky.stderr);
  assert.equal(calls('claude').length, 4); // the hung call, the own error, the 529, the retry

  const silent = lfm({ FAKE_CLAUDE: 'empty-error' }, 'agents', '--test', 'claude'); // an is_error result with no text still names itself
  assert.equal(silent.status, 1);
  assert.match(silent.stderr, /^error: claude: is_error with no message$/m);

  const before = calls('codex').length;
  const stale = lfm({ FAKE_CODEX: 'stale' }, 'agents', '--test', 'codex'); // 529 after writing an answer; the retry writes none
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stderr, /^error: codex: the answer holds no JSON object: empty$/m);
  assert.equal(calls('codex').length - before, 2); // the 529 and the retry

  const none = lfm({ PATH: '/nonexistent' }, 'agents', '--test', 'claude');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: claude is not usable: claude is not on PATH$/m);
});
