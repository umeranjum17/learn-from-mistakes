// End-to-end: the real CLI starts fake claude, codex, opencode, pi, gemini and acpx binaries (PATH holds only them) in a copy of the
// examples, with a throwaway HOME and LFM_HOME. Each fake records its argv, cwd, stdin and env, then answers like its agent.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const MODELS = { claude: 'claude-haiku-5-5', codex: 'gpt-6-luna', opencode: 'opencode-go/muse-spark-1.3-contributor' };
// The global file the user wrote: the tool never picks an agent or a model.
const GLOBAL = `agent: claude\njudge_agent: codex\nagent_config: ${JSON.stringify(Object.fromEntries(Object.entries(MODELS).map(([a, model]) => [a, { model }])))}\n`;
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
  if (name === 'codex') { if (mode !== 'stale' && args.includes('-o')) fs.writeFileSync(args[args.indexOf('-o') + 1], 'Done:\\n\`\`\`json\\n' + text + '\\n\`\`\`\\n'); console.log('tokens used: 10'); }
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
  for (const d of [bin, log, join(home, '.claude'), join(tmp, 'lfm-home')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), GLOBAL);
  writeFileSync(join(home, '.claude', '.credentials.json'), SECRET); // codex and opencode stay logged out
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'acpx']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n${FAKE}`);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { PATH: bin, HOME: home, LFM_HOME: join(tmp, 'lfm-home'), FAKE_LOG: log, XDG_DATA_HOME: join(home, 'data'),
    SIGN_OFF_HOME: home, TMPDIR: tmp, LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: tmp };
  const lfm = (extra, ...args) => {
    const t = Date.now();
    const r = spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, ...extra } });
    return { ...r, secs: (Date.now() - t) / 1000 };
  };
  const calls = (name) => (existsSync(join(log, `${name}.jsonl`)) ? readFileSync(join(log, `${name}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const base = readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8');
  const config = (extra) => writeFileSync(join(p, '.learn-from-mistakes.yaml'), base + extra); // the examples config plus these keys
  const global = (text) => writeFileSync(join(tmp, 'lfm-home', 'config.yaml'), text);
  return { tmp, p, env, lfm, calls, config, global };
}

test('agents lists only the configured agents with version, login presence and model; a broken shim is not usable', () => {
  const { lfm, tmp, config, global, p } = setup();
  const r = lfm({}, 'agents', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const by = Object.fromEntries(out.agents.map((a) => [a.runner, a]));
  assert.deepEqual(Object.keys(by), ['claude', 'codex']); // never the other installed agents: the tool lists none to pick from
  assert.equal(by.claude.usable, true);
  assert.equal(by.claude.version, '1.2.3');
  assert.equal(by.claude.login, '.credentials.json'); // the file name only, never its contents
  for (const a of out.agents) assert.equal(a.model, MODELS[a.runner]);
  assert.deepEqual(out.agents.map((a) => a.tools), ['off', 'read-only']);
  assert.deepEqual(out.worker, { runner: 'claude', model: MODELS.claude, bin: join(tmp, 'bin', 'claude'), problem: '' });
  assert.deepEqual([out.judge.runner, out.judge.model], ['codex', MODELS.codex]);
  assert.ok(!(r.stdout + r.stderr).includes('CANARY'), 'login contents never print');
  assert.match(r.stderr, /^next: learn-from-mistakes-axi agents --test claude/m);

  config('agent: opencode\n'); // the project file overrides the global agent; a broken shim is not usable
  const broken = lfm({ FAKE_OPENCODE: 'broken' }, 'agents', '--json');
  assert.equal(broken.status, 1);
  const row = JSON.parse(broken.stdout).agents.find((a) => a.runner === 'opencode');
  assert.equal(row.usable, false);
  assert.equal(row.login, 'not found (it may be in the system keychain)');
  assert.match(row.problem, /--version failed: No version is set for shim: opencode/);
  assert.match(broken.stderr, /^next: install opencode, or ask the user which agent and model to use, then set agent in .*\/p\/\.learn-from-mistakes\.yaml and its agent_config model in .*\/lfm-home\/config\.yaml; the run never picks one$/m);

  // agent takes one agent: a list is refused with the fix line that names the global file.
  global('agent: [gemini, codex]\njudge_agent: claude\nagent_config: { codex: { model: umer-cheap-1 }, claude: { model: claude-haiku-5-5 } }\n');
  const list = lfm({}, 'agents');
  assert.equal(list.status, 2, list.stderr);
  assert.match(list.stderr, /^error: .*config\.yaml: agent must be one agent, not a list$/m);
  assert.equal(list.stderr.match(/^next: (.*)$/m)[1], `ask the user which one agent to use, then set agent in ${join(tmp, 'lfm-home', 'config.yaml')} to it; the run never picks one`);
  // A set agent that is not ready is the worker's problem: no other agent is tried, though claude is usable.
  global('agent: codex\njudge_agent: claude\nagent_config: { codex: { model: umer-cheap-1 }, claude: { model: claude-haiku-5-5 } }\n');
  config('');
  const notReady = lfm({ FAKE_CODEX: 'broken' }, 'agents', '--json');
  assert.equal(notReady.status, 1, notReady.stderr);
  const nr = JSON.parse(notReady.stdout);
  assert.deepEqual([nr.worker.runner, nr.worker.bin], ['codex', '']);
  assert.match(nr.worker.problem, /^codex is not usable: --version failed: No version is set for shim: codex/);
  assert.match(notReady.stderr, /^next: install codex, or ask the user which agent and model to use, then set agent and its agent_config model in .*\/config\.yaml; the run never picks one$/m);
  global('agent: claude\njudge_agent: codex\nagent_config: { codex: { model: umer-cheap-1 }, claude: { model: claude-haiku-5-5 } }\n');
  const own = lfm({}, 'agents');
  assert.equal(own.status, 0, own.stderr);
  const toon = decode(own.stdout);
  assert.deepEqual([toon.worker.runner, toon.worker.model], ['claude', MODELS.claude]);
  assert.deepEqual([toon.judge.runner, toon.judge.model], ['codex', 'umer-cheap-1']);
  config('agent: gemini\nagent_config: { gemini: { model: umer-gem-1 } }\n'); // one agent that does not resolve: its own problem, and the fix names the file that set it
  const bad = lfm({}, 'agents');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^problem: worker: gemini is not offered: /m);
  assert.match(bad.stderr, /^next: ask the user which agent and model to use, then set agent and its agent_config model in .*\/p\/\.learn-from-mistakes\.yaml; the run never picks one$/m);

  // With none set, the tool picks nothing: a caller that is not a terminal is told to ask the user, with the save command.
  global('');
  config('');
  const none = lfm({}, 'agents');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^error: ask the user which agent to use: agent and judge_agent are not set in .*\/p\/\.learn-from-mistakes\.yaml, and the tool never picks one\. Choices: claude, codex, opencode, pi or byokit:<route>/m);
  assert.equal(none.stderr.match(/^next: (.*)$/m)[1], `learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir ${p}   # with the user's answer`);
  assert.equal(none.stdout, '');
});

test('a hung, leaking, writing or overloaded agent ends with its real cause', () => {
  const { lfm, calls, config, p } = setup();
  config('agent_timeout: 10s\nagent_config: { claude: { model: umer-cheap-1 }, codex: { model: umer-cheap-1 }, gemini: { model: umer-gem-1 }, opencode: { model: opencode-go/umer-cheap-1 } }\n');
  const hang = lfm({ FAKE_CLAUDE: 'hang' }, 'agents', '--test', 'claude');
  assert.equal(hang.status, 1);
  assert.match(hang.stderr, /^error: claude: no answer within 10s in one attempt; stopped it \(agent_timeout\)$/m);
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

  config('agent: pi\nagent_config: { pi: { model: umer-cheap-1 }, "acp:fake-agent": { model: umer-acp-1 } }\n');
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
    let err = '';
    const seed = execFile(process.execPath, ['--input-type=module', '-e', SEED, mock.base], { encoding: 'utf8', cwd: ROOT, env });
    seed.stderr.on('data', (d) => { err += d; });
    after(() => { try { seed.kill('SIGKILL'); } catch {} }); // a failed assertion must not leave the seed polling
    const exited = new Promise((ok) => seed.once('close', (code, signal) => ok(code ?? (signal ? 1 : 0))));
    // Both waits are bounded: the seed shows the mock a device code and exits, or the test names why. An unbounded
    // wait here pins the file open (and the runner cancels every still-running file with the pending-promise failure).
    for (let i = 0; i < 1200 && !mock.lastCode(); i++) await new Promise((ok) => setTimeout(ok, 50)); // up to 60 s
    assert.ok(mock.lastCode(), `the sign-in never showed the mock a device code:\n${err}`);
    mock.approve(mock.lastCode());
    let timer;
    try { assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the seed did not exit in 60 s:\n${err}`)), 60_000); })]), 0, err); }
    finally { clearTimeout(timer); }
  };
  return { ...s, env, mock, lfm, hook, signIn };
}

test('byokit: agents --test makes one plan call through BYOKit with the signed-in plan, after the doctor hook finds the sign-in', async () => {
  const { p, mock, lfm, hook, signIn } = await byokitSetup();
  const yaml = join(p, '.learn-from-mistakes.yaml'), base = readFileSync(yaml, 'utf8');
  const model = 'agent_config: { "byokit:chatgpt": { model: gpt-6-luna } }\n'; // a route takes only the model the user set
  const config = (extra) => writeFileSync(yaml, base + model + extra);
  config('');
  const [out] = await hook('chatgpt');
  assert.deepEqual(out, { status: 'fail', label: 'byokit:chatgpt', detail: "ChatGPT isn't signed in yet.", fix: out.fix });
  assert.match(out.fix, /^sign in to chatgpt through BYOKit for member "lfm"/);
  const out1 = await lfm('agents', '--test', 'byokit:chatgpt');
  assert.equal(out1.status, 1);
  assert.match(out1.stderr, /^error: byokit:chatgpt: ChatGPT isn't signed in yet\.$/m);
  assert.match(out1.stderr, /^next: sign in to chatgpt through BYOKit/m);

  await signIn();
  assert.deepEqual((await hook('chatgpt'))[0], { status: 'ok', label: 'byokit:chatgpt', detail: 'ChatGPT is connected.' });
  const r = await lfm('agents', '--test', 'byokit:chatgpt', '--json');
  assert.equal(r.status, 0, r.stderr);
  const dir = join(p, '.lfm', 'runs', 'test-byokit-chatgpt');
  assert.deepEqual(JSON.parse(r.stdout).test, { runner: 'byokit:chatgpt', tools: 'none', model: 'gpt-6-luna', dir, reply: 'hello from the fake route', offered: true });
  const asked = JSON.parse(mock.state.requests.at(-1).body);
  assert.equal(asked.model, 'gpt-6-luna');
  assert.match(JSON.stringify(asked.input), /lfm-run:test:byokit-chatgpt\\nThis tests that your tools are off/);
  assert.deepEqual(readdirSync(dir), ['prompt-byokit-chatgpt.md']);

  const asks = mock.state.requests.length;
  mock.state.fail = { status: 529, body: '{"error":{"message":"overloaded"}}' }; // busy once, then it answers
  assert.equal((await lfm('agents', '--test', 'byokit:chatgpt')).status, 0);
  assert.equal(mock.state.requests.length - asks, 2);

  config('agent: claude\njudge_agent: "byokit:chatgpt"\n'); // a judge with no second agent CLI
  const roles = await lfm('agents', '--json');
  assert.equal(roles.status, 0, roles.stderr);
  assert.deepEqual(JSON.parse(roles.stdout).judge, { runner: 'byokit:chatgpt', model: 'gpt-6-luna', bin: 'byokit:chatgpt', problem: '' });
  const byokitRow = { runner: 'byokit:chatgpt', model: 'gpt-6-luna', usable: true, version: '', tools: 'none', login: '', bin: 'byokit:chatgpt', problem: '' };
  assert.deepEqual(JSON.parse(roles.stdout).agents.find((a) => a.runner === 'byokit:chatgpt'), byokitRow);
  const text = await lfm('agents'); // the text output lists the same byokit row
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(decode(text.stdout).agents.find((a) => a.runner === 'byokit:chatgpt'), byokitRow);
  config('agent: "byokit:chatgpt"\njudge_agent: "byokit:chatgpt"\n'); // one route in both roles: the user's choice
  const same = await lfm('agents', '--json');
  assert.equal(same.status, 0, same.stderr);
  assert.equal(JSON.parse(same.stdout).judge.runner, 'byokit:chatgpt');
});
