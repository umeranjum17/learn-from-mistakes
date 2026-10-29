// End-to-end: tokens retro over a small synthetic Claude Code and Pi store counts the window's tokens, ranks the causes
// and saves its numbers so the next run shows them as the last; tokens doctor names a store it cannot read and never
// touches the login file beside it; the poll guard blocks the third identical poll in one context and says so.
// LFM_CLI points the same journeys at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-tokens-'));
  after(() => { chmodSync(join(tmp, 'pi-agent', 'auth.json'), 0o600); rmSync(tmp, { recursive: true }); });
  const env = { ...process.env, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm'), CLAUDE_CONFIG_DIR: join(tmp, 'claude'), PI_CODING_AGENT_DIR: join(tmp, 'pi-agent') };
  delete env.PI_CODING_AGENT_SESSION_DIR;
  const write = (file, lines) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`); };
  // Claude: one session, with a context above 200k, three identical polls, a file read three times (twice before a
  // compaction), a failed test run, and one subagent. msg_1 is written as two records, one per content block.
  const at = (h) => ({ cwd: '/work/demo', sessionId: 's-tok', timestamp: ago(h) });
  const usage = (input, cw, cr, output) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: output, cache_creation: { ephemeral_1h_input_tokens: cw, ephemeral_5m_input_tokens: 0 } });
  const call = (h, id, u, tool, input) => ({ type: 'assistant', ...at(h), message: { id, model: 'claude-sonnet-5-5', role: 'assistant', usage: u, content: [{ type: 'tool_use', id: `t-${id}`, name: tool, input }] } });
  const result = (h, id, content, error = false) => ({ type: 'user', ...at(h), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content, is_error: error }] } });
  const poll = { command: 'sleep 30; cat build.status' };
  write(join(tmp, 'claude', 'projects', '-work-demo', 's-tok.jsonl'), [
    { type: 'user', ...at(10), message: { role: 'user', content: 'Ship the build when it is green.' } },
    { type: 'assistant', ...at(9.9), message: { id: 'msg_1', model: 'claude-sonnet-5-5', role: 'assistant', usage: usage(10, 50_000, 0, 5), content: [{ type: 'text', text: 'Waiting.' }] } },
    call(9.9, 'msg_1', usage(10, 50_000, 0, 40), 'Bash', poll), result(9.8, 'msg_1', 'running'),
    call(9.7, 'msg_2', usage(1, 100, 50_050, 30), 'Bash', poll), result(9.6, 'msg_2', 'running'),
    call(9.5, 'msg_3', usage(1, 100, 50_150, 30), 'Bash', poll), result(9.4, 'msg_3', 'done'),
    call(9.3, 'msg_4', usage(1, 30_000, 50_250, 20), 'Read', { file_path: 'README.md' }), result(9.2, 'msg_4', 'x'.repeat(24_000)),
    call(9.1, 'msg_5', usage(1, 200_000, 80_000, 50), 'Read', { file_path: 'README.md' }), result(9.0, 'msg_5', 'x'.repeat(24_000)),
    { type: 'system', subtype: 'compact_boundary', ...at(8.9), compactMetadata: { trigger: 'auto' } },
    call(8.8, 'msg_6', usage(1, 20_000, 10_000, 10), 'Read', { file_path: 'README.md' }), result(8.7, 'msg_6', 'x'.repeat(4000)),
    call(8.6, 'msg_7', usage(1, 100, 30_000, 10), 'Bash', { command: 'npm test' }), result(8.5, 'msg_7', 'Exit code 1\nnot ok 1', true),
  ]);
  write(join(tmp, 'claude', 'projects', '-work-demo', 's-tok', 'subagents', 'agent-a1.jsonl'), [
    { type: 'user', ...at(9), isSidechain: true, message: { role: 'user', content: 'Look up the build log.' } },
    { type: 'assistant', ...at(9), isSidechain: true, message: { id: 'msg_s1', model: 'claude-haiku-5-5', role: 'assistant', usage: usage(1, 5000, 0, 100), content: [{ type: 'text', text: 'Found it.' }] } },
  ]);
  // Outside the window: a request 30 days old in a file that changed today.
  write(join(tmp, 'claude', 'projects', '-work-demo', 's-old.jsonl'), [
    { type: 'assistant', cwd: '/work/demo', sessionId: 's-old', timestamp: ago(720), message: { id: 'msg_old', role: 'assistant', usage: usage(1, 900_000, 0, 1), content: [{ type: 'text', text: 'Old.' }] } },
  ]);
  // Pi: one session of two requests.
  const pi = (h, id, u, content) => ({ type: 'message', id, timestamp: ago(h), message: { role: 'assistant', model: 'gpt-6-luna', provider: 'openai-codex', usage: u, content } });
  write(join(tmp, 'pi-agent', 'sessions', '--work-demo--', 'p1.jsonl'), [
    { type: 'session', id: 'p-tok', timestamp: ago(5), cwd: '/work/demo' },
    { type: 'message', id: 'u1', timestamp: ago(5), message: { role: 'user', content: 'Check the inbox.' } },
    pi(4.9, 'a1', { input: 1000, output: 50, cacheRead: 9000, cacheWrite: 0 }, [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls inbox' } }]),
    { type: 'message', id: 'r1', timestamp: ago(4.8), message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'empty' }], isError: false } },
    pi(4.7, 'a2', { input: 100, output: 20, cacheRead: 10_000, cacheWrite: 0 }, [{ type: 'text', text: 'Nothing new.' }]),
  ]);
  // The login file beside the Pi store: unreadable, holding a planted value that must never show.
  writeFileSync(join(tmp, 'pi-agent', 'auth.json'), '{"key":"PLANTED-LOGIN-VALUE"}');
  chmodSync(join(tmp, 'pi-agent', 'auth.json'), 0o000);
  const project = join(tmp, 'project');
  mkdirSync(project);
  writeFileSync(join(project, '.learn-from-mistakes.yaml'), 'name: demo\nsources: {}\n');
  const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: project, env: { ...env, ...opts.env }, input: opts.input, encoding: 'utf8' });
  return { tmp, project, run };
}

test('tokens retro counts the window, ranks the causes, and the next run shows the last run\'s numbers', () => {
  const { project, run } = setup();
  const first = run(['tokens', 'retro', '--since', '14d']);
  assert.equal(first.status, 0, first.stderr);
  const [line, ...table] = first.stdout.trim().split('\n');
  // The window holds 7 Claude requests (msg_1 at its largest usage), 1 subagent request and 2 Pi requests; the old one is out.
  const claude = 50_050 + 50_181 + 50_281 + 80_271 + 280_051 + 30_011 + 30_111 + 5101, pi = 10_050 + 10_120;
  assert.match(line, /^tokens: 596\.2k\/14d \(claude 576\.1k, pi 20\.2k\) · cache-read \d+% of cost · top: floor 310\.1k, polling 100\.5k, ctx-over-200k 80\.0k · report: .*tokens\.txt$/);
  assert.match(table[0], /^causes\[9\]\{rank,cause,tokens,count,worst_sessions\}:$/);
  assert.match(table[1], /^ {2}1,floor,310\.1k,2,s-tok p-tok$/);
  const report = line.split(' · report: ')[1];
  const json = JSON.parse(readFileSync(report.replace(/tokens\.txt$/, 'tokens.json'), 'utf8'));
  assert.equal(json.total, claude + pi);
  assert.deepEqual([json.by_agent.claude.requests, json.by_agent.pi.requests], [8, 2]);
  const cause = Object.fromEntries(json.causes.map((c) => [c.cause, c]));
  assert.equal(cause.floor.tokens, 50_010 * 6 + 10_000); // each later request re-reads its context's first prompt
  assert.deepEqual([cause.polling.count, cause.polling.tokens], [2, 50_181 + 50_281]); // the second and third identical poll
  assert.deepEqual([cause['ctx-over-200k'].count, cause['ctx-over-200k'].tokens], [1, 80_001]);
  assert.deepEqual([cause.oversized.count, cause.oversized.tokens], [2, 6000]); // msg_4's 24k chars, carried by msg_5
  assert.deepEqual([cause.reread.count, cause['reread-after-compaction'].count], [1, 1]);
  assert.deepEqual([cause['failed-calls'].count, cause['failed-calls'].tokens], [1, 30_111]);
  assert.deepEqual([cause['fan-out'].count, cause['fan-out'].tokens], [1, 5101]);
  assert.match(cause.polling.pointer, /s-tok\.jsonl:\d+$/);
  assert.deepEqual([json.metrics.poll_repeat_turns, json.metrics.prefix_rebuilds, json.metrics.ctx_over_200k_share], [2, 3, 0.1]);
  assert.equal(json.previous, null);
  const text = readFileSync(report, 'utf8');
  assert.match(text, /cache reads are [\d.]+% of the cost/);
  assert.ok(!text.includes('build.status') && !text.includes('Ship the build'), 'no transcript text in the report');
  // The run is saved with its numbers: the next one shows them as the last, and status shows the run's first line.
  const second = run(['tokens', 'retro', '--json']);
  assert.equal(second.status, 0, second.stderr);
  const again = JSON.parse(second.stdout);
  assert.equal(again.previous.poll_repeat_turns, 2);
  const status = run(['status', '--run', String(again.run), '--json']);
  assert.equal(JSON.parse(status.stdout).result.summary.split(' · report: ')[0], line.split(' · report: ')[0]);
  assert.ok(readFileSync(join(project, '.lfm', 'runs', String(again.run), 'tokens.txt'), 'utf8').includes('poll_repeat_turns: 2 (last: 2)'));
});

test('tokens doctor names the store it cannot read with the reason and never touches the login file', () => {
  const { tmp, run } = setup();
  rmSync(join(tmp, 'pi-agent', 'sessions'), { recursive: true });
  writeFileSync(join(tmp, 'pi-agent', 'sessions'), 'not a directory');
  const got = run(['tokens', 'doctor']);
  assert.equal(got.status, 1, got.stderr);
  const lines = got.stdout.trim().split('\n');
  assert.equal(lines[0], 'claude ok · pi unreadable');
  assert.match(lines[1], /^ok {3}claude  2 sessions readable since \S+ at .*claude\/projects$/);
  assert.match(lines[2], /^fail pi {6}cannot read .*pi-agent\/sessions: ENOTDIR \(not a directory\)$/);
  for (const out of [got.stdout, got.stderr]) assert.ok(!out.includes('auth') && !out.includes('PLANTED'), out);
});

test('the poll guard installs once, blocks the third identical poll in one context with one line, fails open, and status says what it blocked', () => {
  const { tmp, run } = setup();
  const settings = join(tmp, 'claude', 'settings.json');
  writeFileSync(settings, '{"theme":"dark","hooks":{"PreToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"true"}]}]}}');
  assert.equal(run(['tokens', 'guard', 'status']).stdout.split('\n')[0], 'poll guard: not installed · blocked 0 today, 0 in total in 0 sessions');
  const installed = run(['tokens', 'guard', 'install']);
  assert.match(installed.stdout, /^poll guard: installed in .*settings\.json/);
  assert.match(run(['tokens', 'guard', 'install']).stdout, /^poll guard: unchanged/);
  const s = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.hooks.PreToolUse.map((e) => e.matcher), ['Read', 'Bash|Edit|Write|MultiEdit|NotebookEdit']);
  assert.equal(s.hooks.SessionStart[0].matcher, 'compact');
  const hook = s.hooks.PreToolUse[1].hooks[0].command;
  const fire = (payload) => spawnSync('sh', ['-c', hook], { env: { ...process.env, LFM_HOME: join(tmp, 'lfm') }, input: typeof payload === 'string' ? payload : JSON.stringify({ session_id: 's-tok', ...payload }), encoding: 'utf8' });
  const poll = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sleep 30;  cat build.status' } };
  assert.deepEqual([fire(poll).stdout, fire(poll).stdout], ['', '']);
  const third = fire(poll);
  assert.equal(third.status, 0);
  const deny = JSON.parse(third.stdout).hookSpecificOutput;
  assert.equal(deny.permissionDecision, 'deny');
  assert.match(deny.permissionDecisionReason, /^poll guard: this same command already ran 2 times in this context .*wait on an event instead/);
  assert.ok(!deny.permissionDecisionReason.includes('\n'));
  fire({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a' } }); // work between: the count starts again
  assert.deepEqual([fire(poll).stdout, fire(poll).stdout], ['', '']);
  fire({ hook_event_name: 'SessionStart', source: 'compact' }); // a compaction starts a new context
  assert.equal(fire(poll).stdout, '');
  for (const bad of ['not json', '{"session_id":"../x","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"sleep 1"}}']) {
    const got = fire(bad);
    assert.deepEqual([got.status, got.stdout], [0, '']); // fail-open: the call goes ahead
  }
  const status = run(['tokens', 'guard', 'status']);
  assert.match(status.stdout.split('\n')[0], /^poll guard: installed \(user .*settings\.json\) · blocked 1 today, 1 in total in 1 sessions · last \S+$/);
  assert.match(status.stdout, /recent\[1\]\{at,session,repeats,command\}:\n {2}\S+,s-tok,2,sleep 30; cat build\.status/);
});
