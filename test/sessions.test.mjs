// End-to-end: a retro with a sessions source reads synthetic Claude Code, Codex and OpenCode stores
// (test/fixtures/sessions/, and sqlite files made here), counts only this repo's sessions, skips the tool's own runs,
// never changes a store, and keeps planted secrets out of the store and output.
// Its metrics step gives the numbers for this window and the last, with the events the cause match rules tagged.
// LFM_CLI points the same journey at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';
// The user's agents, set once in the throwaway global config: a run needs both and the tool never picks one.
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const FAKE_AGENT = new URL('fake-agent/claude', import.meta.url).pathname;
// One planted value per redaction shape, built here so no key-shaped string sits in the repo. [text, what must never show]
const PLANTED = [
  [`${' '.repeat(3978)}gh${'p_'}${'Y'.repeat(36)}`, 'Y'.repeat(6)], // a key after a long whitespace run, cut inside by the 4000 cap
  [`sk${'_live_'}${'P'.repeat(24)}`, 'P'.repeat(24)], [`sk${'_test_'}${'S'.repeat(24)}`, 'S'.repeat(24)],
  [`rk${'_live_'}${'T'.repeat(24)}`, 'T'.repeat(24)], [`--password ${'Q'.repeat(12)}`, 'Q'.repeat(12)],
  [`--token ${'R'.repeat(12)}`, 'R'.repeat(12)],
  [`postgres://umer:${'V'.repeat(16)}@localhost:5432/db`, 'V'.repeat(16)],
  [`npm${'_'}${'W'.repeat(36)}`, 'W'.repeat(36)], [`gl${'pat-'}${'X'.repeat(26)}`, 'X'.repeat(26)],
  [`sk-proj${'A'.repeat(30)}`, 'A'.repeat(30)], [`sk-ant-api03${'B'.repeat(30)}`, 'B'.repeat(30)],
  [`gh${'p_'}${'C'.repeat(36)}`, 'C'.repeat(36)], [`github${'_pat_'}${'D'.repeat(40)}`, 'D'.repeat(40)],
  [`gh${'o_'}${'E'.repeat(36)}`, 'E'.repeat(36)], [`xo${'xb-'}1234567890-umerslack`, 'umerslack'],
  [`AK${'IA'}${'F'.repeat(16)}`, 'F'.repeat(16)], [`AI${'za'}${'G'.repeat(35)}`, 'G'.repeat(35)],
  [`ey${'JhbGciOiJIUzI1NiJ9'}.ey${'JzdWIiOiJVbWVyIn0'}.${'H'.repeat(20)}`, 'JzdWIiOiJVbWVyIn0'],
  [`-----BEGIN ${'PRIVATE KEY'}-----\nMIIE${'I'.repeat(40)}\n-----END PRIVATE KEY-----`, 'I'.repeat(40)],
  [`Bearer ${'J'.repeat(24)}`, 'J'.repeat(24)], [`API_TOKEN=${'K'.repeat(12)}`, 'K'.repeat(12)],
  [`"password": "${'L'.repeat(12)}"`, 'L'.repeat(12)], ['umer@example.com', 'umer@example.com'],
  [`password="correct horse ${'M'.repeat(8)}"`, 'M'.repeat(8)], [`Authorization: Basic ${'N'.repeat(20)}`, 'N'.repeat(20)],
  [`secret=abc,${'O'.repeat(10)}`, 'O'.repeat(10)],
  [`postgres://u:${'E'.repeat(8)}/${'F'.repeat(8)}@h/db`, 'F'.repeat(8)], // a password with a slash
  [`postgres://u:${'G'.repeat(8)}@${'H'.repeat(8)}@h/db`, 'H'.repeat(8)], // a password with an @
  [`bearer Bearer ${'Z'.repeat(24)}`, 'Z'.repeat(24)], // the keyword-doubled token: the real token must go
  [`https://hooks.slack.com/services/T000/B000/${'U'.repeat(24)}`, 'U'.repeat(24)], // Slack webhook: the path is the secret
];

const planted = (from, to) => JSON.stringify(PLANTED.slice(from, to).map(([t]) => t).join(' ')).slice(1, -1); // as JSON string text
const day = (back) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-sessions-'));
  after(() => rmSync(tmp, { recursive: true }));
  const p = join(tmp, 'p'), tree = join(tmp, 'wt'), claude = join(tmp, 'home', '.claude');
  cpSync(new URL('../examples', import.meta.url).pathname, p, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', p, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.name=Umer', '-c', 'user.email=umer@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', '--detach', tree);
  const gate = new DatabaseSync(join(p, 'gate.sqlite')); // the example store's one repo is this project, by its origin
  gate.prepare('UPDATE repos SET working_path = ?').run('/elsewhere/p');
  gate.close();
  git('remote', 'add', 'origin', 'https://example.invalid/umer/example.git');
  const fill = (text) => text.replaceAll('$REPO', p).replaceAll('$TREE', tree)
    .replace(/2026-10-0([1-3])T/g, (_, d) => `${day(3 - Number(d))}T`) // the last three days, so inside the window
    .replaceAll('2026-09-24T', `${day(10)}T`) // inside the last window
    .replaceAll('$SECRETS_A', planted(0, -12)).replaceAll('$SECRETS_B', planted(-12));
  const src = new URL('fixtures/sessions/claude/projects', import.meta.url).pathname;
  for (const f of readdirSync(src, { recursive: true })) {
    if (!f.endsWith('.jsonl')) continue;
    mkdirSync(join(claude, 'projects', f, '..'), { recursive: true });
    writeFileSync(join(claude, 'projects', f), fill(readFileSync(join(src, f), 'utf8')));
  }
  const old = new Date(Date.now() - 60 * 86_400_000); // before the read range of two 7d windows
  utimesSync(join(claude, 'projects', '-repo', 's-old.jsonl'), old, old);
  utimesSync(join(claude, 'projects', '-repo', 's-main.jsonl'), old, old); // its subagent file changed later, so it is read
  const cfg = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8').replace('sources:\n', 'sources:\n  sessions: { type: sessions, agents: [claude] }\n').replace('causes:\n', `causes:
  fetch-test-fails: { description: The fetch tests fail., match: { source: sessions, signal: test_fail, text_contains: fetch.test } }
  missing-file: { description: The agent reads a file that is not there., match: { source: sessions, signal: tool_error, tool: Read } }
`)}targets: { defects: "<= 1", interrupts: "> 1", "cause_count:fetch-test-fails": "<= 1", "cause_count:missing-file": "= 0", "cause_count:server-memory-kill": "<= 0" }
`);
  writeFileSync(join(p, 'defects.md'), `${readFileSync(join(p, 'defects.md'), 'utf8')}\n## ${day(1)}\n\n- [tests] Umer's fetch tests failed.\n- [tests] Again.\n\n## ${day(10)}\n\n- [tests] Once last week.\n`);
  // PATH holds the fake agent (the analyse step's worker and the judge), node for its #! line, and git.
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  symlinkSync(FAKE_AGENT, join(bin, 'claude'));
  symlinkSync(FAKE_AGENT, join(bin, 'codex'));
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(bin, 'git'));
  const env = { ...process.env, PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm'), CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(tmp, 'home', '.codex'), XDG_DATA_HOME: join(tmp, 'home', '.local', 'share'),
    SIGN_OFF_HOME: join(tmp, 'home'), TMPDIR: tmp, LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: tmp };
  mkdirSync(env.LFM_HOME, { recursive: true });
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), AGENTS_SET);
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  return { tmp, p, tree, claude, env, fill, lfm };
}

// No planted value reaches any output or any file under .lfm/.
function assertNoPlanted(p, outputs) {
  const state = readdirSync(join(p, '.lfm'), { recursive: true }).map((f) => { try { return readFileSync(join(p, '.lfm', f), 'latin1'); } catch { return ''; } });
  for (const [, needle] of PLANTED) {
    for (const o of outputs) assert.ok(!o.stdout.includes(needle) && !o.stderr.includes(needle), `${needle} in output`);
    for (const bytes of state) assert.ok(!bytes.includes(needle), `${needle} in .lfm`);
  }
}

const query = (p, sql, ...args) => {
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...args).map((r) => ({ ...r })); } finally { db.close(); }
};

test('a retro reads this repo\'s Claude Code sessions, skips its own runs and keeps planted secrets out', () => {
  const { p, claude, env, lfm } = setup();
  const unreadable = process.getuid?.() !== 0 ? join(claude, 'projects', '-other', 's-other.jsonl') : null; // root reads anything
  if (unreadable) chmodSync(unreadable, 0o000);
  const cfg = join(p, '.learn-from-mistakes.yaml'), examples = readFileSync(cfg, 'utf8');

  // No sessions yet, and no other source: the run completes with 0 sessions and every number n/a, never 0.
  writeFileSync(cfg, 'sources:\n  sessions: { type: sessions, agents: [claude] }\n');
  const empty = spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--dir', p], { encoding: 'utf8', env: { ...env, CLAUDE_CONFIG_DIR: join(claude, '..', 'none') } });
  assert.equal(empty.status, 0, empty.stderr);
  writeFileSync(cfg, examples);
  assert.deepEqual(decode(empty.stdout).sources.find((s) => s.type === 'sessions'), { id: 'sessions', type: 'sessions', items: 0, sessions: 0, skipped: 0 });
  const TARGETS = { tool_error_rate: '<= 0.05', corrections_per_session: '<= 0.3', first_pass: '>= 70', p90_hours_to_merge: '<= 8', escaped: '<= 0' }; // the defaults
  assert.deepEqual(decode(empty.stdout).metrics, ['defects', 'gate_failures', 'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'merged', 'first_pass',
    'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'rework_per_merge', 'reverted', 'escaped', 'ci_runs', 'ci_failure_rate', 'ci_reruns', 'ci_flaky_jobs',
    'decisions', 'blocks', 'steers', 'interventions_per_merge', 'corrections_per_merge', 'hours_working', 'hours_queued', 'hours_waiting_captain', 'hours_waiting_ci', 'hours_in_review', 'hours_blocked', 'hours_merge_wait', 'tasks_timed']
    .map((name) => ({ name, current: 'n/a', previous: 'n/a', target: TARGETS[name] ?? '', met: TARGETS[name] ? 'n/a' : '' }))); // the numbers of the types with no source here; n/a is never met or missed

  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  const run = decode(r.stdout);
  assert.equal(run.run.status, 'completed');
  // this repo, a subdir and a worktree; not the other project, a sibling dir, .lfm/, the marker run or an old file
  assert.deepEqual(run.sources.find((s) => s.type === 'sessions'),
    { id: 'sessions', type: 'sessions', items: 39, sessions: 4, skipped: unreadable ? 3 : 2 });
  const id = run.run.id;
  // This window: the 4 sessions and 2 dated defects. The last: s-main's 4 Read results (3 failed), 1 correction and
  // 1 defect. An event or defect older than both is stored, never counted. A cause with no match rule is n/a; the gate
  // rule's rows are from March, so 0.
  // Each number with a target says whether this window met it, at the boundary too (1 <= 1, but not 1 > 1); n/a is neither.
  assert.deepEqual(run.metrics, [['defects', 2, 1, '<= 1', 'missed'], ...['', ':lint', ':review', ':test'].map((s) => [`gate_failures${s}`, 0, 0, '', '']), ['tool_error_rate', 0.5, 0.75, '<= 0.05', 'missed'],
    ['corrections_per_session', 0.25, 2, '<= 0.3', 'met'], ['interrupts', 1, 0, '> 1', 'missed'], ['retries', 1, 0, '', ''],
    ...['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'rework_per_merge', 'reverted', 'escaped', 'ci_runs', 'ci_failure_rate', 'ci_reruns', 'ci_flaky_jobs']
      .map((name) => [name, 'n/a', 'n/a', { first_pass: '>= 70', p90_hours_to_merge: '<= 8', escaped: '<= 0' }[name] ?? '', name in { first_pass: 1, p90_hours_to_merge: 1, escaped: 1 } ? 'n/a' : '']),
    ...['decisions', 'blocks', 'steers', 'interventions_per_merge', 'corrections_per_merge', 'hours_working', 'hours_queued', 'hours_waiting_captain', 'hours_waiting_ci', 'hours_in_review', 'hours_blocked', 'hours_merge_wait', 'tasks_timed'].map((name) => [name, 'n/a', 'n/a', '', '']),
    ['cause_count:fetch-test-fails', 1, 0, '<= 1', 'met'], ['cause_count:missing-file', 0, 3, '= 0', 'met'], ['cause_count:server-memory-kill', 'n/a', 'n/a', '<= 0', 'n/a'],
    ['cause_count:shared-cache-lock', 'n/a', 'n/a', '', ''], ['cause_count:agent-exit-wait', 0, 0, '', '']]
    .map(([name, current, previous, target, met]) => ({ name, current, previous, target, met })));
  assert.equal(Date.parse(run.window.current_start) - Date.parse(run.window.previous_start), 7 * 86_400_000);
  assert.deepEqual(query(p, `SELECT window, value FROM metrics WHERE run_id = ? AND name IN ('defects', 'escaped') ORDER BY name, window`, id),
    [{ window: 'current', value: 2 }, { window: 'previous', value: 1 }, { window: 'current', value: null }, { window: 'previous', value: null }]); // n/a is NULL
  // The store keeps each window's target, NULL with none; the verdict is shown, not stored.
  assert.deepEqual(query(p, `SELECT window, target FROM metrics WHERE run_id = ? AND name IN ('defects', 'escaped', 'retries') ORDER BY name, window`, id),
    [{ window: 'current', target: '<= 1' }, { window: 'previous', target: '<= 1' }, { window: 'current', target: '<= 0' },
      { window: 'previous', target: '<= 0' }, { window: 'current', target: null }, { window: 'previous', target: null }]);
  // The rules tag exactly the planted events: the one failed fetch test run, and the 5 failed Reads (2 older than both windows).
  const tags = (run) => query(p, 'SELECT cause, signal, tool, count(*) AS n FROM events WHERE run_id = ? AND cause IS NOT NULL GROUP BY cause', run);
  assert.deepEqual(tags(id), [{ cause: 'fetch-test-fails', signal: 'test_fail', tool: 'Bash', n: 1 }, { cause: 'missing-file', signal: 'tool_error', tool: 'Read', n: 5 }]);
  assert.deepEqual(query(p, 'SELECT source, cause, count(*) AS n FROM records WHERE run_id = ? GROUP BY source, cause', id),
    [{ source: 'gate', cause: null, n: 1 }, { source: 'gate', cause: 'agent-exit-wait', n: 4 }, { source: 'log', cause: null, n: 16 }]);
  assert.deepEqual(query(p, 'SELECT DISTINCT session_id FROM events WHERE run_id = ? ORDER BY 1', id).map((e) => e.session_id), ['s-main', 's-own', 's-sub', 's-tree']);
  const signals = Object.fromEntries(query(p, 'SELECT signal, count(*) AS n FROM events WHERE run_id = ? AND signal IS NOT NULL GROUP BY signal', id).map((e) => [e.signal, e.n]));
  assert.deepEqual(signals, { correction: 5, interrupt: 1, retry: 1, test_fail: 2, tool_error: 6 }); // every stored event; a reply after an error is not a correction, a later success does not clear it, a wrapper does not either
  const sub = query(p, `SELECT session_id, tool, signal FROM events WHERE run_id = ? AND ref LIKE '%/subagents/agent-a1.jsonl:%' AND kind = 'tool_result'`, id);
  assert.deepEqual(sub, [{ session_id: 's-main', tool: 'Grep', signal: 'tool_error' }]); // a subagent file is read
  assert.deepEqual(query(p, `SELECT exit_code FROM events WHERE run_id = ? AND signal = 'test_fail'`, id).map((e) => e.exit_code), [1, 1]);

  // Every planted shape is redacted in the excerpts (a tool error, the retried call's input, a correction), all
  // within the kept 300 characters, and no planted value reaches the store, state or output.
  for (const signal of ['test_fail', 'retry', 'correction']) {
    const [{ excerpt }] = query(p, 'SELECT excerpt FROM events WHERE run_id = ? AND signal = ? ORDER BY id LIMIT 1', id, signal);
    assert.ok(excerpt.includes(' END') && excerpt.includes('[redacted]') && excerpt.length <= 300, excerpt);
  }
  assertNoPlanted(p, [r, lfm('status', '--json'), lfm('runs'), lfm('report', '--json'), lfm('report', '--full')]);
  assert.ok(!r.stdout.includes(claude) && !r.stdout.includes('UMER_FIXTURES'), 'no session path or text in the retro output');

  // A session id the run store recorded as the tool's own agent run is skipped next time; excerpts: off keeps none.
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.prepare(`INSERT INTO invocations (run_id, step, role, runner, model, marker, started_at, session_id) VALUES (1, 'analyse', 'worker', 'claude', '', 'lfm-run:1:analyse', '2026-10-01T00:00:00Z', 's-own')`).run();
  db.close();
  writeFileSync(cfg, `${examples}excerpts: off\n`);
  const off = lfm('retro', '--foreground', '--json');
  assert.equal(off.status, 0, off.stderr);
  const second = JSON.parse(off.stdout);
  assert.equal(second.sources.find((s) => s.type === 'sessions').sessions, 3);
  assert.deepEqual(query(p, `SELECT count(*) AS n FROM events WHERE run_id = ? AND excerpt != ''`, second.run.id), [{ n: 0 }]);
  assert.deepEqual(tags(second.run.id), tags(id)); // text_contains reads the whole text, not the excerpt
  assert.deepEqual(query(p, 'SELECT count(*) AS n FROM events WHERE run_id = ?', id), [{ n: 39 }]); // the first run keeps its events
});

const text = (t, extra) => ({ type: 'text', text: t, ...extra });
const tool = (name, input, state) => ({ type: 'tool', tool: name, callID: `call-${name}`, state: { input, ...state } });
test('a retro reads this repo\'s Pi and Gemini CLI sessions and keeps planted secrets out', () => {
  const { tmp, p, env, lfm } = setup();
  for (const k of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'GEMINI_CLI_HOME']) delete env[k]; // the stores under HOME
  const secrets = (from, to) => PLANTED.slice(from, to).map(([t]) => t).join(' '), now = new Date().toISOString();
  const old = new Date(Date.now() - 60 * 86_400_000), elsewhere = join(tmp, 'elsewhere');
  const put = (file, lines, at) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, lines.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
    if (at) utimesSync(file, at, at);
  };
  const pi = join(env.HOME, '.pi', 'agent', 'sessions', '--repo--'), head = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: now, cwd });
  const msg = (message) => ({ type: 'message', id: 'e1', parentId: null, timestamp: now, message });
  const call = (id, name, args, extra) => msg({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], ...extra });
  const result = (id, text, isError) => msg({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text }], isError });
  put(join(pi, '2026-10-13T10-00_pi-main.jsonl'), [head('pi-main', p), msg({ role: 'user', content: 'Umer: the fetch tests fail, fix it.' }),
    call('c1', 'bash', { command: 'npm test' }), result('c1', `FAIL fetch ${secrets(0, -12)} END\n\nCommand exited with code 1`, true),
    msg({ role: 'user', content: [{ type: 'text', text: `Umer: use the other script, ${secrets(-12)} END` }] }),
    call('c2', 'bash', { command: 'npm test' }), result('c2', 'ok', false), call('c3', 'read', { path: 'a.js' }), result('c3', 'ENOENT', true),
    call('c4', 'bash', { command: 'npm test' }), result('c4', 'Command aborted', true), // stopped by the user: no failure
    call('c5', 'bash', { command: 'npm test | tail -20' }),
    result('c5', `ℹ tests 2\nℹ pass 1\nℹ fail 1\n\nCommand exited with code 0`, false), // the pipe exits 0: only the node --test summary line shows the tests failed
    call('c6', 'bash', { command: 'npm test' }),
    result('c6', `npm warn cleanup 3 failed to download\n\nCommand exited with code 0`, false), // a stray "N failed" that is no runner summary line stays invisible
    msg({ role: 'assistant', content: [], stopReason: 'aborted' }), msg({ role: 'user', content: 'Umer: wait.' }), 'not json']);
  const failing = [msg({ role: 'user', content: 'lfm-run:9:analyse Follow the bundle.' }), call('c1', 'read', {}), result('c1', 'no', true)];
  put(join(pi, 'b_pi-marker.jsonl'), [head('pi-marker', p), ...failing]);
  put(join(pi, 'c_pi-lfm.jsonl'), [head('pi-lfm', join(p, '.lfm', 'runs', '1')), ...failing.slice(1)]);
  put(join(pi, 'd_pi-other.jsonl'), [head('pi-other', elsewhere), ...failing.slice(1)]);
  put(join(pi, 'e_pi-old.jsonl'), [head('pi-old', p), ...failing.slice(1)], old);
  put(join(pi, 'f_pi-fork.jsonl'), [{ ...head('pi-fork', p), parentSession: 'a.jsonl' }, ...failing.slice(1).map((r) => ({ ...r, timestamp: old.toISOString() }))]);

  const gem = join(env.HOME, '.gemini'), chats = join(gem, 'tmp', 'umer-p', 'chats');
  put(join(gem, 'projects.json'), [{ projects: { [p]: 'umer-p', [elsewhere]: 'umer-x' } }]);
  const tc = (name, args, status, out) => ({ name, args, status, result: out === undefined ? null : [{ functionResponse: { response: status === 'error' ? { error: out } : { output: out } } }] });
  const g = (id, ...toolCalls) => ({ id, type: 'gemini', timestamp: now, content: '', toolCalls });
  put(join(chats, 'session-2026-10-13T10-00-gm000001.jsonl'), [{ sessionId: 'gm000001-main', startTime: now, kind: 'main' },
    { id: 'u0', type: 'user', content: 'Umer: a draft.' }, { $set: { messages: [] } }, { id: 'u1', type: 'user', content: [{ text: '/src/x.mjs is the file, run the checks.' }] },
    g('g1'), g('g1', tc('run_shell_command', { command: 'npx vitest run' }, 'success', `Exit Code: 0\nvitest crashed ${secrets(0, -12)} END\nExit Code: 1`)),
    { id: 'h1', type: 'user', content: '<hook_context>open: a.js</hook_context>' }, { id: 'u2', type: 'user', content: `Umer: try again, ${secrets(-12)} END` }, g('g2', tc('run_shell_command', { command: 'npx vitest run' }, 'success', 'Exit Code: 3\nok')),
    g('g3', tc('read_file', { file_path: 'b.js' }, 'error', 'File not found')), { $rewindTo: 'g3' }, { id: 'u3', type: 'user', content: '/stats' },
    g('g4', tc('replace', { file_path: 'c.js' }, 'cancelled')), { $set: { summary: 'Umer' } }, 'not json']);
  put(join(chats, 'gm000001-main', 'sub1.jsonl'), [{ sessionId: 'sub1', kind: 'subagent' }, { id: 's1', type: 'user', content: 'Find the loader.' },
    g('s2', tc('read_file', { file_path: 'x.js' }, 'error', 'not found'))]);
  const gfail = [{ id: 'n1', type: 'user', content: 'lfm-run:9:analyse Follow the bundle.' }, g('n2', tc('read_file', {}, 'error', 'no'))];
  put(join(chats, 'session-2026-10-13T10-01-gm000002.jsonl'), [{ sessionId: 'gm000002-mark' }, ...gfail]);
  put(join(chats, 'session-2026-10-13T10-02-gm000003.jsonl'), [{ sessionId: 'gm000003-old' }, ...gfail.slice(1)], old);
  put(join(gem, 'tmp', 'umer-x', 'chats', 'session-2026-10-13T10-00-gm000004.jsonl'), [{ sessionId: 'gm000004-other' }, ...gfail.slice(1)]);

  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  sessions: { type: sessions, agents: [pi, gemini] }\n');
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  const run = decode(r.stdout), id = run.run.id;
  // this repo's sessions with a Gemini subagent and a Pi fork with none of its parent's copied entries; not the marker runs, .lfm/, the other project or slug, or old files; a replaced, rewritten, rewound or command message is not an event; bad records: a non-JSON line in each kept file.
  assert.deepEqual(run.sources.find((s) => s.type === 'sessions'), { id: 'sessions', type: 'sessions', items: 29, sessions: 3, skipped: 2 });
  assert.deepEqual(query(p, 'SELECT agent, session_id, count(*) AS n FROM events WHERE run_id = ? GROUP BY 1, 2 ORDER BY 1, 2', id),
    [{ agent: 'gemini', session_id: 'gm000001-main', n: 11 }, { agent: 'pi', session_id: 'pi-fork', n: 1 }, { agent: 'pi', session_id: 'pi-main', n: 17 }]);
  const signals = query(p, 'SELECT agent, signal, count(*) AS n FROM events WHERE run_id = ? AND signal IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2', id);
  assert.deepEqual(signals.map((e) => `${e.agent} ${e.signal} ${e.n}`),
    ['correction', 'interrupt', 'retry', 'tool_error'].flatMap((s) => [`gemini ${s} 1`, `pi ${s} 1`]).concat(['gemini test_fail 1', 'pi test_fail 2']).sort());
  assert.deepEqual(query(p, `SELECT tool, exit_code, from_output FROM events WHERE run_id = ? AND signal = 'test_fail' ORDER BY agent, exit_code`, id),
    [{ tool: 'run_shell_command', exit_code: 1, from_output: 0 }, { tool: 'bash', exit_code: 0, from_output: 1 }, { tool: 'bash', exit_code: 1, from_output: 0 }]); // a shell exit of 1 is a failure even with status success; a piped exit of 0 is one only from the output
  // The bundle shows where the failure signal came from: this one only the output's summary line proved.
  assert.equal(readFileSync(join(p, '.lfm', 'runs', String(id), 'bundle.md'), 'utf8').split(' (from output)').length - 1, 1);
  for (const [{ excerpt }] of ['test_fail', 'correction'].flatMap((s) => ['pi', 'gemini'].map((a) => query(p, 'SELECT excerpt FROM events WHERE run_id = ? AND agent = ? AND signal = ?', id, a, s)))) {
    assert.ok(excerpt.includes(' END') && excerpt.includes('[redacted]') && excerpt.length <= 300, excerpt);
  }
  assertNoPlanted(p, [r, lfm('report', '--full')]);
  // A session id the run store recorded as the tool's own agent run is skipped next time, for each agent.
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  for (const sid of ['pi-main', 'pi-fork', 'gm000001-main']) db.prepare(`INSERT INTO invocations (run_id, step, role, runner, model, marker, started_at, session_id) VALUES (1, 'analyse', 'worker', 'claude', '', 'lfm-run:1:analyse', '2026-10-01T00:00:00Z', ?)`).run(sid);
  db.close();
  assert.equal(JSON.parse(lfm('retro', '--foreground', '--json').stdout).sources.find((s) => s.type === 'sessions').sessions, 0);
});
