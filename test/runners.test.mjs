// End-to-end: the real CLI starts fake claude, codex, opencode, pi, gemini and acpx binaries (PATH holds only them) in a copy of the
// examples, with a throwaway HOME and LFM_HOME. Each fake records its argv, cwd, stdin and env, then answers like its agent.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const MODELS = JSON.parse(readFileSync(new URL('../src/models.json', import.meta.url), 'utf8'));
const SECRET = 'CANARY-login-secret-5d1e';
// FAKE_<RUNNER>: ok (default), broken (--version exits 1), hang, grandchild (holds stdout after exit), write, flaky (529 once),
// prose (answers in plain text, no JSON), error (claude's is_error result; pi's error message, exit 0), empty-error (claude's is_error result with no text), stale (codex writes its answer then 529s; the retry writes nothing).
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
  if (mode === 'color-exit') { console.error('\\x1b[31mAuthentication cancelled by user.\\x1b[0m'); process.exit(130); }
  if (mode === 'grandchild') spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
  const text = mode === 'prose' ? 'I cannot create x.txt: my tools are off.' : JSON.stringify({ reply: 'hello from ' + name });
  if (name === 'claude') console.log(JSON.stringify({ type: 'result', is_error: mode === 'error' || mode === 'empty-error', result: mode === 'empty-error' ? undefined : mode === 'error' ? "The model's tool call could not be parsed" : text }));
  if (name === 'codex') { if (mode !== 'stale') fs.writeFileSync(args[args.indexOf('-o') + 1], 'Done:\\n\`\`\`json\\n' + text + '\\n\`\`\`\\n'); console.log('tokens used: 10'); }
  if (name === 'opencode') console.log(JSON.stringify({ type: 'text', part: { text: 'thinking' } }) + '\\n' + JSON.stringify({ type: 'text', part: { text } }));
  if (name === 'pi') console.log(JSON.stringify({ type: 'session' }) + '\\n' + JSON.stringify({ type: 'message_end', message: mode === 'error'
    ? { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400: Model is unavailable.' }
    : { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }], stopReason: 'stop' } }));
  if (name === 'gemini') console.log(JSON.stringify({ response: text, stats: {} }));
  if (name === 'acpx') for (const t of [text.slice(0, 5), text.slice(5)]) console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } }));
}
`;

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-run-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'p'), bin = join(tmp, 'bin'), log = join(tmp, 'log'), home = join(tmp, 'home');
  cpSync(new URL('../examples', import.meta.url).pathname, p, { recursive: true });
  for (const d of [bin, log, join(home, '.claude')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), SECRET); // codex and opencode stay logged out
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'acpx']) {
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
  assert.deepEqual(Object.keys(by), ['claude', 'codex', 'opencode', 'pi', 'gemini', 'acp']);
  assert.equal(by.claude.usable, true);
  assert.equal(by.claude.version, '1.2.3');
  assert.equal(by.claude.login, '.credentials.json'); // the file name only, never its contents
  assert.equal(by.opencode.login, 'not found (it may be in the system keychain)');
  assert.equal(by.codex.usable, false);
  assert.match(by.codex.problem, /--version failed: No version is set for shim: codex/);
  for (const a of out.agents) assert.equal(a.model, MODELS[a.runner]?.[0] ?? ''); // defaults come from src/models.json; acp: the target's own
  assert.deepEqual(out.agents.map((a) => a.tools), ['off', 'read-only', 'off', 'off', 'read-only', 'unconfirmed']);
  assert.equal(by.acp.bin, join(tmp, 'bin', 'acpx'));
  assert.equal(by.pi.problem, ''); // offered: its tool-off mode is confirmed live
  for (const r of ['gemini', 'acp']) { // usable, so --test can check them, but never picked as worker or judge
    assert.equal(by[r].usable, true);
    assert.match(by[r].problem, /^not offered: /);
  }
  assert.deepEqual(out.worker, { runner: 'claude', model: MODELS.claude[0], bin: join(tmp, 'bin', 'claude'), problem: '' });
  assert.equal(out.judge.runner, 'opencode'); // the first usable identity that differs from the worker's
  assert.ok(!(r.stdout + r.stderr).includes('CANARY'), 'login contents never print');
  assert.match(r.stderr, /^next: learn-from-mistakes-axi agents --test claude/m);

  const own = lfm({ LFM_MODEL: 'gpt-6-luna' }, 'agents'); // a listed model moves the auto worker to the CLI that lists it
  assert.equal(own.status, 0, own.stderr);
  const toon = decode(own.stdout);
  assert.deepEqual(toon.agents.map((a) => [a.runner, a.model]), [['claude', MODELS.claude[0]], ['codex', 'gpt-6-luna'], ['opencode', MODELS.opencode[0]],
    ['pi', ''], ['gemini', ''], ['acp', '']]);
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

test('a runner whose tool-off mode is not confirmed is never worker or judge, and says why', () => {
  const { p, lfm, config, tmp } = setup();
  config('worker: { runner: gemini }\njudge: { runner: acp:fake-agent }\n');
  const r = lfm({}, 'agents', '--json');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^problem: worker: gemini is not offered: its read-only plan mode is not yet confirmed in headless mode/m);
  assert.match(r.stderr, /^problem: judge: acp is not offered: acpx --deny-all only denies the permission requests an agent sends/m);

  cpSync(new URL('../examples/.learn-from-mistakes.yaml', import.meta.url).pathname, join(p, '.learn-from-mistakes.yaml'));
  mkdirSync(join(tmp, 'lfm-home'));
  writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), JSON.stringify({ runner_path: Object.fromEntries(['claude', 'codex', 'opencode', 'pi'].map((x) => [x, join(tmp, `no-such-${x}`)])) }));
  const auto = lfm({}, 'agents', '--json'); // only gemini is installed: auto names it and why it is not offered
  assert.equal(auto.status, 1, auto.stderr);
  assert.match(auto.stderr, /^problem: worker: gemini is not offered: its read-only plan mode is not yet confirmed in headless mode/m);
  assert.doesNotMatch(auto.stderr, /no usable agent CLI/);
});

test('agents --test starts each runner tool-off in its run dir, with the marker first and the runner default model', () => {
  const { p, lfm, calls, config, tmp } = setup();
  mkdirSync(join(tmp, 'lfm-home'));
  writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), 'runner_args: { codex: [--ignore-rules] }\n');
  config('caps: { timeout: 30s }\n');
  for (const runner of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'acp:fake-agent']) {
    const r = lfm({}, 'agents', '--test', runner, '--json');
    assert.equal(r.status, 0, r.stderr);
    const bin = runner === 'acp:fake-agent' ? 'acpx' : runner, step = runner.replace(':', '-');
    const dir = join(p, '.lfm', 'runs', `test-${step}`);
    assert.deepEqual(JSON.parse(r.stdout).test, { runner, model: MODELS[runner]?.[0] ?? '', tools: { codex: 'read-only', gemini: 'read-only', 'acp:fake-agent': 'unconfirmed' }[runner] ?? 'off', dir,
      reply: `hello from ${bin}`, offered: !['gemini', 'acp:fake-agent'].includes(runner) });
    if (bin !== runner) assert.match(r.stderr, /^next: learn-from-mistakes-axi agents .*# why acp:fake-agent is not offered as worker or judge/m);
    const [c] = calls(bin);
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
  const [pi] = calls('pi'), [gm] = calls('gemini'), [ax] = calls('acpx');
  assert.deepEqual(pi.args, ['-p', '--mode', 'json', '--no-session', '--no-tools', '--no-context-files', '--no-skills', '--no-extensions']);
  assert.match(pi.stdin, /^lfm-run:test:pi\nThis tests that your tools are off/);
  assert.deepEqual(gm.args, ['-p', 'lfm-run:test:gemini Follow the instructions above.', '-o', 'json', '--approval-mode', 'plan', '--skip-trust', '-e', 'none']);
  assert.match(gm.stdin, /^lfm-run:test:gemini\nThis tests that your tools are off/);
  assert.deepEqual(ax.args, ['--cwd', run('acp-fake-agent'), '--format', 'json', '--json-strict', '--deny-all', '--allowed-tools', '', '--non-interactive-permissions', 'deny',
    'fake-agent', 'exec', '--file', '-']);
  assert.match(ax.stdin, /^lfm-run:test:acp-fake-agent\nThis tests that your tools are off/);
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
  config('caps: { timeout: 10s }\n');
  const hang = lfm({ FAKE_CLAUDE: 'hang' }, 'agents', '--test', 'claude');
  assert.equal(hang.status, 1);
  assert.match(hang.stderr, /^error: claude: no answer within 10s in one attempt; stopped it \(caps\.timeout\)$/m);
  assert.ok(hang.secs < 16, `killed at the timeout, took ${hang.secs}s`);

  const color = lfm({ FAKE_GEMINI: 'color-exit' }, 'agents', '--test', 'gemini'); // a colored error line reaches the user plain
  assert.equal(color.status, 1);
  assert.match(color.stderr, /^error: gemini: exited 130: Authentication cancelled by user\.$/m);
  assert.ok(!color.stderr.includes('\x1b'), 'no escape bytes in the error');

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

  const piErr = lfm({ FAKE_PI: 'error' }, 'agents', '--test', 'pi'); // pi exits 0 on a failed call; its error message is the cause
  assert.equal(piErr.status, 1);
  assert.match(piErr.stderr, /^error: pi: 400: Model is unavailable\.$/m);
  const acpWrite = lfm({ FAKE_ACPX: 'write' }, 'agents', '--test', 'acp:fake-agent'); // an ACP agent that runs tools without asking
  assert.equal(acpWrite.status, 1);
  assert.match(acpWrite.stderr, /^error: acp wrote x\.txt in its run dir .*test-acp-fake-agent: its tools are not off$/m);

  const none = lfm({ PATH: '/nonexistent' }, 'agents', '--test', 'claude');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: claude is not usable: claude is not on PATH$/m);
});

// BYOKit: BYOKit's stand-in OpenAI plays the ChatGPT plan (LFM_TEST_BYOKIT_BASE). The sign-in sits in the throwaway HOME's
// BYOKit machine store, sealed by a host key file there; DBus points nowhere, so no session keyring is touched.
const ROOT = new URL('..', import.meta.url).pathname;
const BYOKIT = new URL('../src/runners/byokit.mjs', import.meta.url).pathname;
const node = (env, ...args) => new Promise((ok) => execFile(process.execPath, args, { encoding: 'utf8', cwd: ROOT, env },
  (e, stdout, stderr) => ok({ status: e ? e.code : 0, stdout, stderr })));
const HOOK = 'const { doctor } = await import(process.argv[1]); console.log(JSON.stringify(await doctor(process.argv[2])));';
const SEED = `import { Accounts, machineStore, portable } from '@byokit/accounts'; import { osKeyringSeal } from '@byokit/secrets';
const seal = osKeyringSeal({ service: 'byokit' }), a = new Accounts({ authBase: process.argv[1], store: (m) => machineStore(m, seal) }, portable);
await a.login('lfm', 'chatgpt'); await a.finished('lfm', 'chatgpt'); a.stop();`;

async function byokitSetup() {
  const { mockOpenAI } = await import('@byokit/accounts/testing');
  const s = setup();
  const home = join(s.tmp, 'home');
  const mock = await mockOpenAI({ answers: [{ match: 'lfm-run:test:byokit-chatgpt', text: '{"reply":"hello from the fake route"}' }] });
  after(() => mock.close());
  const env = { ...s.env, XDG_STATE_HOME: join(home, '.local', 'state'), DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(s.tmp, 'no-bus')}`, LFM_TEST_BYOKIT_BASE: mock.base };
  const lfm = (...args) => node(env, CLI, ...args, '--dir', s.p);
  const hook = async (route, file = BYOKIT) => { const r = await node(env, '--input-type=module', '-e', HOOK, file, route); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const signIn = async () => {
    const seed = node(env, '--input-type=module', '-e', SEED, mock.base);
    while (!mock.lastCode()) await new Promise((ok) => setTimeout(ok, 50));
    mock.approve(mock.lastCode());
    assert.equal((await seed).status, 0);
  };
  return { ...s, env, mock, lfm, hook, signIn };
}

test('byokit: agents --test makes one plan call through BYOKit with the signed-in plan, after the doctor hook finds the sign-in', async () => {
  const { p, mock, lfm, hook, signIn } = await byokitSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml'), base = readFileSync(yaml, 'utf8');
  const config = (extra) => writeFileSync(yaml, base + extra);
  const [node22, out] = await hook('chatgpt');
  assert.equal(node22.status, 'ok');
  assert.deepEqual(out, { status: 'fail', label: 'byokit:chatgpt', detail: "ChatGPT isn't signed in yet.", fix: out.fix });
  assert.match(out.fix, /^sign in to chatgpt through BYOKit for member "lfm"/);
  const out1 = await lfm('agents', '--test', 'byokit:chatgpt');
  assert.equal(out1.status, 1);
  assert.match(out1.stderr, /^error: byokit:chatgpt: ChatGPT isn't signed in yet\.$/m);
  assert.match(out1.stderr, /^next: sign in to chatgpt through BYOKit/m);

  await signIn();
  assert.deepEqual((await hook('chatgpt'))[1], { status: 'ok', label: 'byokit:chatgpt', detail: 'ChatGPT is connected.' });
  const r = await lfm('agents', '--test', 'byokit:chatgpt', '--json');
  assert.equal(r.status, 0, r.stderr);
  const dir = join(p, '.lfm', 'runs', 'test-byokit-chatgpt');
  assert.deepEqual(JSON.parse(r.stdout).test, { runner: 'byokit:chatgpt', tools: 'none', model: 'gpt-6-luna', dir, reply: 'hello from the fake route', offered: true });
  const asked = JSON.parse(mock.state.requests.at(-1).body);
  assert.equal(asked.model, 'gpt-6-luna'); // the catalogue's cheap model, never its strong one
  assert.match(JSON.stringify(asked.input), /lfm-run:test:byokit-chatgpt\\nThis tests that your tools are off/);
  assert.deepEqual(readdirSync(dir), ['prompt-byokit-chatgpt.md']);

  const asks = mock.state.requests.length;
  mock.state.fail = { status: 529, body: '{"error":{"message":"overloaded"}}' }; // busy once, then it answers
  assert.equal((await lfm('agents', '--test', 'byokit:chatgpt')).status, 0);
  assert.equal(mock.state.requests.length - asks, 2);

  config('worker: { runner: claude }\njudge: { runner: "byokit:chatgpt" }\n'); // a judge with no second agent CLI
  const roles = await lfm('agents', '--json');
  assert.equal(roles.status, 0, roles.stderr);
  assert.deepEqual(JSON.parse(roles.stdout).judge, { runner: 'byokit:chatgpt', model: 'gpt-6-luna', bin: 'byokit:chatgpt', problem: '' });
  config('worker: { runner: "byokit:chatgpt" }\njudge: { runner: "byokit:chatgpt", model: gpt-6-luna }\n'); // the same route judging itself
  const clash = await lfm('agents', '--json');
  assert.equal(clash.status, 1);
  assert.match(JSON.parse(clash.stdout).judge.problem, /would judge its own work/);
});

// A stand-in for a plan key provider's Responses API: it records each request and streams one fixed answer.
async function keyStandIn(text) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      const ev = (type, x) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...x })}\n\n`);
      const item = { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      ev('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      ev('response.output_text.delta', { output_index: 0, item_id: 'm1', content_index: 0, delta: text });
      ev('response.output_item.done', { output_index: 0, item });
      ev('response.completed', { response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

test('byokit: a plan key route answers with the key from its variable, held in memory and never saved', async () => {
  const { p, tmp, env } = await byokitSetup();
  const standIn = await keyStandIn('{"reply":"hello from the fake key route"}');
  const run = (vars, ...args) => node({ ...env, LFM_TEST_BYOKIT_BASE: standIn.base, ...vars }, CLI, ...args, '--dir', p);
  const hook = async (vars) => JSON.parse((await node({ ...env, ...vars }, '--input-type=module', '-e', HOOK, BYOKIT, 'opencode-go')).stdout);
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}worker: { runner: "byokit:opencode-go" }\n`);
  const noModel = await run({ OPENCODE_API_KEY: 'fake-key' }, 'agents', '--test', 'byokit:opencode-go'); // no catalogue model: never a guessed default
  assert.equal(noModel.status, 1);
  assert.match(noModel.stderr, /^error: byokit:opencode-go: BYOKit's catalogue has no cheap model for opencode-go$/m);
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('"byokit:opencode-go" }', '"byokit:opencode-go", model: muse-spark-1.3-contributor }'));

  assert.deepEqual((await hook({}))[1], { status: 'fail', label: 'byokit:opencode-go', detail: 'OPENCODE_API_KEY is not set',
    fix: 'set OPENCODE_API_KEY to your OpenCode Go key, then: learn-from-mistakes-axi agents --test byokit:opencode-go' });
  const noKey = await run({}, 'agents', '--test', 'byokit:opencode-go');
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /^error: byokit:opencode-go: OPENCODE_API_KEY is not set$/m);
  assert.match(noKey.stderr, /^next: set OPENCODE_API_KEY to your OpenCode Go key/m);
  assert.equal(standIn.seen.length, 0);

  assert.deepEqual((await hook({ OPENCODE_API_KEY: 'fake-key' }))[1], { status: 'ok', label: 'byokit:opencode-go', detail: 'OPENCODE_API_KEY is set' });
  const r = await run({ OPENCODE_API_KEY: 'fake-key' }, 'agents', '--test', 'byokit:opencode-go', '--json');
  assert.equal(r.status, 0, r.stderr);
  const dir = join(p, '.lfm', 'runs', 'test-byokit-opencode-go');
  assert.deepEqual(JSON.parse(r.stdout).test, { runner: 'byokit:opencode-go', tools: 'none', model: 'muse-spark-1.3-contributor', dir, reply: 'hello from the fake key route', offered: true });
  const [asked] = standIn.seen;
  assert.equal(asked.path, '/responses');
  assert.equal(asked.headers.authorization, 'Bearer fake-key');
  assert.match(asked.headers['x-opencode-session'], /^[0-9a-f-]{36}$/);
  assert.equal(asked.body.model, 'muse-spark-1.3-contributor');
  assert.match(JSON.stringify(asked.body.input), /lfm-run:test:byokit-opencode-go\\nThis tests that your tools are off/);
  assert.deepEqual(readdirSync(dir), ['prompt-byokit-opencode-go.md']);
  assert.equal(existsSync(join(tmp, 'home', '.local', 'share', 'byokit')), false); // no BYOKit store was made
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('muse-spark-1.3-contributor', 'no-such-model'));
  const bad = await run({ OPENCODE_API_KEY: 'fake-key' }, 'agents', '--test', 'byokit:opencode-go');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: byokit:opencode-go: pi-ai lists no model no-such-model for opencode-go$/m);
});

test('byokit: a name that is not a plan route, a claude route with no cheap model and a missing package each name the fix', async () => {
  const { tmp, lfm, hook } = await byokitSetup();
  const unknown = await lfm('agents', '--test', 'byokit:grok');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^error: byokit:grok: byokit:grok is not a BYOKit plan route$/m);
  assert.match(unknown.stderr, /^next: use one of: byokit:chatgpt, byokit:claude, .*byokit:opencode-go/m);
  assert.equal((await hook('grok'))[0].status, 'fail');
  const claude = await lfm('agents', '--test', 'byokit:claude'); // only opus in the catalogue: never a premium default
  assert.equal(claude.status, 1);
  assert.match(claude.stderr, /^error: byokit:claude: BYOKit's catalogue has no cheap model for claude$/m);
  assert.match(claude.stderr, /^next: set the role's model, such as worker: \{ runner: "byokit:claude", model: <model> \}$/m);
  const bad = await lfm('agents', '--test', 'byokit:../x');
  assert.equal(bad.status, 2);

  const lone = join(tmp, 'lone'); // the runner file with no node_modules above it: BYOKit is not installed
  mkdirSync(lone);
  cpSync(BYOKIT, join(lone, 'byokit.mjs'));
  assert.deepEqual(await hook('chatgpt', join(lone, 'byokit.mjs')), [{ status: 'fail', label: 'byokit:chatgpt', detail: 'BYOKit is not installed',
    fix: 'npm install -g learn-from-mistakes-axi   # with its optional dependencies (not --omit=optional): the BYOKit packages install beside it' }]);
});

test('byokit: with no agent CLI the agents hint lists the ready routes; a worker that names no plan route exits 1 with the problem', async () => {
  const { p, env, lfm, tmp } = await byokitSetup();
  const none = await node({ ...env, PATH: join(tmp, 'empty') }, CLI, 'agents', '--dir', p); // no agent CLI on PATH; BYOKit is installed
  assert.equal(none.status, 1, none.stderr);
  assert.match(none.stderr, /^next: set worker\.runner and judge\.runner in \.learn-from-mistakes\.yaml to byokit:<route>; ready: byokit:chatgpt, byokit:claude, .*byokit:opencode-go, .*byokit:zai-coding-cn$/m);
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}worker: { runner: "byokit:grok" }\n`);
  const r = await lfm('agents');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^problem: worker: byokit:grok is not a BYOKit plan route: use one of: byokit:chatgpt, byokit:claude, .*byokit:opencode-go, .*byokit:zai-coding-cn$/m);
});

test('byokit: with no agent CLI and BYOKit not installed, the hint gives BYOKit\'s own fix next to the agent CLI options', () => {
  const { tmp, p, env } = setup();
  const app = join(tmp, 'app'); // the CLI tree with every dependency but BYOKit's packages
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  for (const d of ['bin', 'src']) cpSync(new URL(`../${d}`, import.meta.url).pathname, join(app, d), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url).pathname, join(app, 'package.json'));
  for (const e of readdirSync(join(ROOT, 'node_modules'))) if (!e.startsWith('@byokit') && e !== '@earendil-works') symlinkSync(join(ROOT, 'node_modules', e), join(app, 'node_modules', e));
  mkdirSync(join(tmp, 'empty'));
  const r = spawnSync(process.execPath, [join(app, 'bin', 'learn-from-mistakes-axi.mjs'), 'agents', '--dir', p], { encoding: 'utf8', env: { ...env, PATH: join(tmp, 'empty') } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^next: install an agent CLI, set runner_path in \$LFM_HOME\/config\.yaml, or for byokit:<route>: npm install -g learn-from-mistakes-axi /m);
});

test('byokit: a judge with no agent CLI is told to set judge.runner to a ready route, not a different model', async () => {
  const { p, env, tmp, config } = setup();
  config('worker: { runner: "byokit:opencode-go", model: muse-spark-1.3-contributor }\n'); // a worker on a plan key route; the judge has no agent CLI
  const r = await node({ ...env, PATH: join(tmp, 'empty'), OPENCODE_API_KEY: 'fake-key' }, CLI, 'agents', '--dir', p);
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /problem: worker/);
  assert.match(r.stderr, /^problem: judge: no usable agent CLI/m);
  assert.match(r.stderr, /^next: install an agent CLI, or set judge\.runner in \.learn-from-mistakes\.yaml to byokit:<route>; ready: byokit:chatgpt, byokit:claude, .*byokit:opencode-go/m);
  assert.doesNotMatch(r.stderr, /judge\.model/);
});
