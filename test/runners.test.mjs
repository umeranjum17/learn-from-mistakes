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
import { parse } from 'yaml';

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
  const env = { PATH: bin, HOME: home, LFM_HOME: join(tmp, 'lfm-home'), FAKE_LOG: log, XDG_DATA_HOME: join(home, 'data') };
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

test('the judge may be the worker\'s agent and model, or that vendor\'s BYOKit sign-in route: both resolve', () => {
  const { lfm, config } = setup();
  for (const [yaml, judgeModel] of [['agent: claude\njudge_agent: claude\n', 'claude-sonnet-5-5'], // the default judge model, not the worker's
    [`agent: claude\njudge_agent: "byokit:claude"\nagent_config: { claude: { model: ${MODELS.claude} }, "byokit:claude": { model: ${MODELS.claude} } }\n`, MODELS.claude]]) {
    config(yaml);
    const r = lfm({}, 'agents', '--json');
    assert.equal(r.status, 0, r.stderr);
    const { worker, judge } = JSON.parse(r.stdout);
    assert.deepEqual([worker.model, judge.model, judge.problem || ''], [MODELS.claude, judgeModel, '']);
  }
});

test('a runner whose tool-off mode is not confirmed is never worker or judge, and says why', () => {
  const { lfm, config } = setup();
  config('agent: gemini\njudge_agent: acp:fake-agent\nagent_config: { gemini: { model: umer-gem-1 }, "acp:fake-agent": { model: umer-acp-1 } }\n');
  const r = lfm({}, 'agents', '--json');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^problem: worker: gemini is not offered: its read-only plan mode is not yet confirmed in headless mode/m);
  assert.match(r.stderr, /^problem: judge: acp:fake-agent is not offered: acpx --deny-all only denies the permission requests an agent sends/m);

});

test('agents --test starts each runner tool-off in its run dir, with the marker first and its agent_config model and effort', () => {
  const { p, lfm, calls, config, global } = setup();
  global(`agent: claude\njudge_agent: codex\nagent_args_override: { codex: [--ignore-rules], acp: [--umer-flag] }
agent_config: { claude: { model: ${MODELS.claude}, effort: low }, codex: { model: ${MODELS.codex}, effort: medium }, opencode: { model: ${MODELS.opencode}, effort: high },
  pi: { model: umer/pi-1, effort: minimal }, gemini: { model: umer-gem-1 } }\n`);
  config('agent_timeout: 30s\nagent_config: { "acp:fake-agent": { model: umer-acp-1 } }\n'); // the project file adds to the global agent_config
  for (const runner of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'acp:fake-agent']) {
    const r = lfm({}, 'agents', '--test', runner, '--json');
    assert.equal(r.status, 0, r.stderr);
    const bin = runner === 'acp:fake-agent' ? 'acpx' : runner, step = runner.replace(':', '-');
    const dir = join(p, '.lfm', 'runs', `test-${step}`);
    assert.deepEqual(JSON.parse(r.stdout).test, { runner, model: MODELS[runner] ?? { pi: 'umer/pi-1', gemini: 'umer-gem-1', 'acp:fake-agent': 'umer-acp-1' }[runner], tools: { codex: 'read-only', gemini: 'read-only', 'acp:fake-agent': 'unconfirmed' }[runner] ?? 'off', dir,
      reply: `hello from ${bin}`, offered: !['gemini', 'acp:fake-agent'].includes(runner) });
    const [c] = calls(bin);
    assert.equal(c.cwd, dir);
    assert.ok(!existsSync(join(dir, 'x.txt')));
  }
  const [cl] = calls('claude'), [cx] = calls('codex'), [oc] = calls('opencode');
  const run = (r) => join(p, '.lfm', 'runs', `test-${r}`);
  assert.deepEqual(cl.args, ['-p', '--output-format', 'json', '--model', MODELS.claude, '--effort', 'low', '--tools', '', '--no-session-persistence', '--strict-mcp-config']);
  assert.match(cl.stdin, /^lfm-run:test:claude\nThis tests that your tools are off/);
  assert.deepEqual(cx.args, ['exec', '-m', MODELS.codex, '-c', 'model_reasoning_effort="medium"', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-o', join(run('codex'), 'out-codex.txt'), '-']);
  assert.match(cx.stdin, /^lfm-run:test:codex\n/);
  assert.deepEqual(oc.args, ['run', '-m', MODELS.opencode, '--variant', 'high', '--format', 'json', '--dir', run('opencode'), '-f', join(run('opencode'), 'prompt-opencode.md'),
    '--', 'lfm-run:test:opencode Follow the instructions in the attached file.']);
  assert.equal(oc.permission, '{"*":"deny"}');
  assert.match(readFileSync(join(run('opencode'), 'prompt-opencode.md'), 'utf8'), /^lfm-run:test:opencode\nThis tests that your tools are off/);
  const [pi] = calls('pi'), [gm] = calls('gemini'), [ax] = calls('acpx');
  assert.deepEqual(pi.args, ['-p', '--model', 'umer/pi-1', '--thinking', 'minimal', '--mode', 'json', '--no-session', '--no-tools', '--no-context-files', '--no-skills', '--no-extensions']);
  assert.match(pi.stdin, /^lfm-run:test:pi\nThis tests that your tools are off/);
  assert.deepEqual(gm.args, ['-p', 'lfm-run:test:gemini Follow the instructions above.', '-m', 'umer-gem-1', '-o', 'json', '--approval-mode', 'plan', '--skip-trust', '-e', 'none']);
  assert.match(gm.stdin, /^lfm-run:test:gemini\nThis tests that your tools are off/);
  assert.deepEqual(ax.args, ['--cwd', run('acp-fake-agent'), '--format', 'json', '--json-strict', '--deny-all', '--allowed-tools', '', '--non-interactive-permissions', 'deny',
    '--model', 'umer-acp-1', '--umer-flag', 'fake-agent', 'exec', '--file', '-']);
  assert.match(ax.stdin, /^lfm-run:test:acp-fake-agent\nThis tests that your tools are off/);
  assert.deepEqual(readdirSync(join(p, '.lfm')).sort(), ['.gitignore', 'runs']);
});

test('an unset model of a judge_agent is named as judge_agent in the fix, never as agent', () => {
  const { p, lfm, config } = setup();
  config('judge_agent: pi\n');
  const t = lfm({}, 'agents', '--test', 'pi');
  assert.equal(t.status, 1);
  assert.match(t.stderr, /^error: pi: no model set in agent_config$/m);
  assert.equal(t.stderr.match(/^next: (.*)$/m)[1], `ask the user which agent and model to use, then set judge_agent and its agent_config model in ${join(p, '.learn-from-mistakes.yaml')}; the run never picks one`);
});

test('every model the user set is called, a premium name too; an unset model is never called', () => {
  const { p, lfm, calls, config } = setup();
  config('agent: claude\nagent_config: { claude: { model: claude-opus-5-5 } }\n');
  const r = lfm({}, 'doctor', '--live', '--json');
  const checks = JSON.parse(r.stdout).checks;
  assert.deepEqual(['worker model', 'worker live'].map((l) => checks.find((c) => c.label === l)?.level), ['ok', 'ok'], r.stdout);
  assert.equal(checks.find((c) => c.label === 'worker model').detail, 'claude-opus-5-5');
  assert.equal(lfm({}, 'agents', '--test', 'claude').status, 0);
  assert.ok(calls('claude').some((c) => c.args.includes('claude-opus-5-5')), JSON.stringify(calls('claude')));

  // pi with no model set: no call is made, and the key to set is named.
  const noModel = lfm({}, 'agents', '--test', 'pi');
  assert.equal(noModel.status, 1);
  assert.match(noModel.stderr, /^error: pi: no model set in agent_config$/m);
  assert.equal(noModel.stderr.match(/^next: (.*)$/m)[1], `ask the user which agent and model to use, then set agent and its agent_config model in ${join(p, '.learn-from-mistakes.yaml')}; the run never picks one`);
  config('agent: pi\njudge_agent: claude\n');
  const asked = lfm({}, 'doctor', '--live');
  assert.equal(asked.status, 2, asked.stderr);
  assert.match(asked.stderr, /^error: ask the user which agent to use: agent_config\.pi\.model is not set in /m);
  assert.equal(calls('pi').length, 0);
  config('agent: pi\nagent_config: { pi: { model: umer-cheap-1 } }\n');
  assert.equal(lfm({}, 'agents', '--test', 'pi').status, 0);
});

test('the skill row looks where the agent CLI reads skills: its login check\'s config dir, not the home default', () => {
  const { lfm, tmp, config } = setup();
  config('agent: pi\njudge_agent: claude\nagent_config: { pi: { model: umer-cheap-1 } }\n');
  const r = lfm({ PI_CODING_AGENT_DIR: join(tmp, 'pi-agent') }, 'doctor', '--json');
  const row = JSON.parse(r.stdout).checks.find((c) => c.label === 'skill pi');
  assert.equal(row.detail, `not installed in ${join(tmp, 'pi-agent', 'skills', 'lfm-retro')}`);
});

test('init writes no agent or model the user did not choose', () => {
  const { lfm, env, p } = setup();
  rmSync(join(env.LFM_HOME, 'config.yaml'));
  const r = lfm({}, 'init', '-y');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(parse(readFileSync(join(env.LFM_HOME, 'config.yaml'), 'utf8')), null); // the global file init wrote: every key commented
  const project = parse(readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8'));
  for (const k of ['agent', 'judge_agent', 'agent_config']) assert.equal(project[k], undefined);
  assert.match(r.stderr, /^next: learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> /m);
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

// A stand-in for a plan key provider's Responses API: it records each request and streams one fixed answer.
async function keyStandIn(text) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
      const ev = (type, x) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...x })}\n\n`);
      if (req.url.endsWith('/chat/completions')) { // a chat completions route such as zai:plan_key streams plain choice chunks
        const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'glm-4.7', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        chunk({ role: 'assistant', content: text }, null);
        chunk({}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
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
  const hook = async (vars, route = 'opencode-go') => JSON.parse((await node({ ...env, ...vars }, '--input-type=module', '-e', HOOK, BYOKIT, route)).stdout);
  const yaml = join(p, '.learn-from-mistakes.yaml');
  const base = readFileSync(yaml, 'utf8');
  const noModel = await run({ ZAI_CODING_CN_API_KEY: 'fake-key' }, 'agents', '--test', 'byokit:zai-coding-cn'); // no default model: never a guessed one
  assert.equal(noModel.status, 1);
  assert.match(noModel.stderr, /^error: byokit:zai-coding-cn: no model set in agent_config$/m);
  assert.match(noModel.stderr, /^next: ask the user which agent and model to use, then set agent in .* and its agent_config model in /m);
  writeFileSync(yaml, `${base}agent_config: { "byokit:opencode-go": { model: muse-spark-1.3-contributor } }\n`);

  assert.deepEqual((await hook({}))[0], { status: 'fail', label: 'byokit:opencode-go', detail: 'OPENCODE_API_KEY is not set',
    fix: 'set OPENCODE_API_KEY to your OpenCode Go key, then: learn-from-mistakes-axi agents --test byokit:opencode-go' });
  const noKey = await run({}, 'agents', '--test', 'byokit:opencode-go');
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /^error: byokit:opencode-go: OPENCODE_API_KEY is not set$/m);
  assert.match(noKey.stderr, /^next: set OPENCODE_API_KEY to your OpenCode Go key/m);
  assert.equal(standIn.seen.length, 0);

  assert.deepEqual((await hook({ OPENCODE_API_KEY: 'fake-key' }))[0],{ status: 'ok', label: 'byokit:opencode-go', detail: 'OPENCODE_API_KEY is set' });
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


  writeFileSync(yaml, `${base}agent_config: { "byokit:opencode-go": { model: no-such-model } }\n`);
  const bad = await run({ OPENCODE_API_KEY: 'fake-key' }, 'agents', '--test', 'byokit:opencode-go');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: byokit:opencode-go: pi-ai lists no model no-such-model for opencode-go$/m);

  // A ready route with no alias names itself by its full id (zai:plan_key): the runner, doctor and the model list all
  // take it, with readiness from a dummy key value and the call answered by the stand-in's chat completions stream.
  writeFileSync(yaml, `${base}agent_config: { "byokit:zai:plan_key": { model: glm-4.7 } }\n`);
  const zaiNoKey = await run({}, 'agents', '--test', 'byokit:zai:plan_key');
  assert.equal(zaiNoKey.status, 1);
  assert.match(zaiNoKey.stderr, /^error: byokit:zai:plan_key: ZAI_API_KEY is not set$/m);
  assert.match(zaiNoKey.stderr, /^next: set ZAI_API_KEY to your Z\.AI key, then: learn-from-mistakes-axi agents --test byokit:zai:plan_key/m);
  assert.deepEqual((await hook({}, 'zai:plan_key'))[0], { status: 'fail', label: 'byokit:zai:plan_key', detail: 'ZAI_API_KEY is not set',
    fix: 'set ZAI_API_KEY to your Z.AI key, then: learn-from-mistakes-axi agents --test byokit:zai:plan_key' });
  assert.deepEqual((await hook({ ZAI_API_KEY: 'fake-zai-key' }, 'zai:plan_key'))[0], { status: 'ok', label: 'byokit:zai:plan_key', detail: 'ZAI_API_KEY is set' });
  const zai = await run({ ZAI_API_KEY: 'fake-zai-key' }, 'agents', '--test', 'byokit:zai:plan_key', '--json');
  assert.equal(zai.status, 0, zai.stderr);
  assert.deepEqual(JSON.parse(zai.stdout).test, { runner: 'byokit:zai:plan_key', tools: 'none', model: 'glm-4.7', dir: join(p, '.lfm', 'runs', 'test-byokit-zai:plan_key'), reply: 'hello from the fake key route', offered: true });
  const zaiAsk = standIn.seen.find((s) => s.path.endsWith('/chat/completions'));
  assert.equal(zaiAsk.headers.authorization, 'Bearer fake-zai-key');
  assert.equal(zaiAsk.body.model, 'glm-4.7');
});

test('byokit: a name that is not a plan route, a route with no model set and a missing package each name the fix', async () => {
  const { tmp, lfm, hook } = await byokitSetup();
  const unknown = await lfm('agents', '--test', 'byokit:grok');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^error: byokit:grok: byokit:grok is not a BYOKit plan route$/m);
  assert.match(unknown.stderr, /^next: use one of: byokit:chatgpt, byokit:claude, .*byokit:opencode-go/m);
  assert.equal((await hook('grok'))[0].status, 'fail');
  const claude = await lfm('agents', '--test', 'byokit:claude'); // never a model the user did not set
  assert.equal(claude.status, 1);
  assert.match(claude.stderr, /^error: byokit:claude: no model set in agent_config$/m);
  assert.match(claude.stderr, /^next: ask the user which agent and model to use, then set agent in .* and its agent_config model in /m);
  const bad = await lfm('agents', '--test', 'byokit:../x');
  assert.equal(bad.status, 2);

  const lone = join(tmp, 'lone'); // the runner file with no node_modules above it: the BYOKit packages are missing
  mkdirSync(lone);
  cpSync(BYOKIT, join(lone, 'byokit.mjs'));
  assert.deepEqual(await hook('chatgpt', join(lone, 'byokit.mjs')), [{ status: 'fail', label: 'byokit:chatgpt', detail: 'the BYOKit packages are missing from this install',
    fix: 'npm install -g learn-from-mistakes-axi   # reinstall: the BYOKit packages are its dependencies' }]);
});

test('byokit: a role that is not installed says to install it or choose another; a worker that names no plan route exits 1 with the problem', async () => {
  const { p, env, lfm, tmp } = await byokitSetup();
  const none = await node({ ...env, PATH: join(tmp, 'empty') }, CLI, 'agents', '--dir', p); // no agent CLI on PATH
  assert.equal(none.status, 1, none.stderr);
  assert.match(none.stderr, /^problem: worker: claude is not usable: claude is not on PATH$/m);
  assert.match(none.stderr, /^next: install claude, or ask the user which agent and model to use, then set agent and its agent_config model in .*config\.yaml; the run never picks one$/m);
  const yaml = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(yaml, `${readFileSync(yaml, 'utf8')}agent: "byokit:grok"\nagent_config: { "byokit:grok": { model: umer-cheap-1 } }\n`);
  const r = await lfm('agents');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^problem: worker: byokit:grok is not a BYOKit plan route$/m);
  assert.match(r.stderr, /^next: use one of: byokit:chatgpt, byokit:claude, .*byokit:opencode-go, .*byokit:zai-coding-cn$/m);
});

test('byokit: a route the user set in an install missing the BYOKit packages says to reinstall', () => {
  // The BYOKit packages install with the tool, as dependencies: no install of it goes without them.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.optionalDependencies, undefined);
  for (const d of ['@byokit/accounts', '@byokit/secrets', '@earendil-works/pi-ai']) assert.ok(pkg.dependencies[d], d);
  const { tmp, p, env, config } = setup();
  config('agent: "byokit:opencode-go"\nagent_config: { "byokit:opencode-go": { model: muse-spark-1.3-contributor } }\n');
  const app = join(tmp, 'app'); // the CLI tree with every dependency but BYOKit's packages
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  for (const d of ['bin', 'src']) cpSync(new URL(`../${d}`, import.meta.url).pathname, join(app, d), { recursive: true });
  cpSync(new URL('../package.json', import.meta.url).pathname, join(app, 'package.json'));
  for (const e of readdirSync(join(ROOT, 'node_modules'))) if (!e.startsWith('@byokit') && e !== '@earendil-works') symlinkSync(join(ROOT, 'node_modules', e), join(app, 'node_modules', e));
  const r = spawnSync(process.execPath, [join(app, 'bin', 'learn-from-mistakes-axi.mjs'), 'agents', '--dir', p], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^problem: worker: the BYOKit packages are missing from this install$/m);
  assert.match(r.stderr, /^next: npm install -g learn-from-mistakes-axi   # reinstall: the BYOKit packages are its dependencies$/m);
});

test('byokit: a judge whose agent CLI is not installed is told to install it or set judge_agent to another agent', async () => {
  const { p, env, tmp, config } = setup();
  config('agent: "byokit:opencode-go"\nagent_config: { "byokit:opencode-go": { model: muse-spark-1.3-contributor } }\n'); // the global judge is codex
  const r = await node({ ...env, PATH: join(tmp, 'empty'), OPENCODE_API_KEY: 'fake-key' }, CLI, 'agents', '--dir', p);
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /problem: worker/);
  assert.match(r.stderr, /^problem: judge: codex is not usable: codex is not on PATH$/m);
  assert.equal(r.stderr.match(/^next: (.*)$/m)[1], `install codex, or ask the user which agent and model to use, then set judge_agent and its agent_config model in ${join(env.LFM_HOME, 'config.yaml')}; the run never picks one`);
});
