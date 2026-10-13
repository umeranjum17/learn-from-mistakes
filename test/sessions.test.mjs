// End-to-end: a retro with a sessions source reads synthetic Claude Code, Codex and OpenCode stores
// (test/fixtures/sessions/, and sqlite files made here), counts only this repo's sessions, skips the tool's own runs,
// never changes a store, and keeps planted secrets out of the store and output.
// Its metrics step gives the numbers for this window and the last, with the events the cause match rules tagged.
// LFM_CLI points the same journey at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
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
    .replaceAll('$SECRETS_A', planted(0, -10)).replaceAll('$SECRETS_B', planted(-10));
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
  writeFileSync(cfg, `${readFileSync(cfg, 'utf8').replace('sources:\n', 'sources:\n  sessions: { type: sessions }\n').replace('causes:\n', `causes:
  fetch-test-fails: { description: The fetch tests fail., match: { source: sessions, signal: test_fail, text_contains: fetch.test } }
  missing-file: { description: The agent reads a file that is not there., match: { source: sessions, signal: tool_error, tool: Read } }
`)}targets: { defects: "<= 1", interrupts: "> 1", "cause_count:fetch-test-fails": "<= 1", "cause_count:missing-file": "= 0", "cause_count:server-memory-kill": "<= 0" }
`);
  writeFileSync(join(p, 'defects.md'), `${readFileSync(join(p, 'defects.md'), 'utf8')}\n## ${day(1)}\n\n- [tests] Umer's fetch tests failed.\n- [tests] Again.\n\n## ${day(10)}\n\n- [tests] Once last week.\n`);
  const env = { ...process.env, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm'), CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(tmp, 'home', '.codex'), XDG_DATA_HOME: join(tmp, 'home', '.local', 'share') };
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

test('a project dir that cannot be listed is counted as skipped and the retro still completes', { skip: process.getuid?.() === 0 }, () => {
  const { claude, lfm } = setup();
  const before = decode(lfm('retro', '--foreground').stdout).sources.find((s) => s.type === 'sessions');
  const dir = join(claude, 'projects', '-repo');
  chmodSync(dir, 0o000);
  try {
    const r = lfm('retro', '--foreground');
    assert.equal(r.status, 0, r.stderr);
    const after = decode(r.stdout).sources.find((s) => s.type === 'sessions');
    assert.equal(after.skipped, 1); // the unlistable dir; its own malformed records are not read
    assert.ok(after.sessions < before.sessions, `${after.sessions} sessions with the repo dir unlistable`);
  } finally { chmodSync(dir, 0o755); }
});

test('a retro reads this repo\'s Claude Code sessions, skips its own runs and keeps planted secrets out', () => {
  const { p, claude, env, lfm } = setup();
  const unreadable = process.getuid?.() !== 0 ? join(claude, 'projects', '-other', 's-other.jsonl') : null; // root reads anything
  if (unreadable) chmodSync(unreadable, 0o000);
  const cfg = join(p, '.learn-from-mistakes.yaml'), examples = readFileSync(cfg, 'utf8');

  // No sessions yet, and no other source: the run completes with 0 sessions and every number n/a, never 0.
  writeFileSync(cfg, 'sources:\n  sessions: { type: sessions }\n');
  const empty = spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--dir', p], { encoding: 'utf8', env: { ...env, CLAUDE_CONFIG_DIR: join(claude, '..', 'none') } });
  assert.equal(empty.status, 0, empty.stderr);
  writeFileSync(cfg, examples);
  assert.deepEqual(decode(empty.stdout).sources.find((s) => s.type === 'sessions'), { id: 'sessions', type: 'sessions', items: 0, sessions: 0, skipped: 0 });
  const TARGETS = { tool_error_rate: '<= 0.05', corrections_per_session: '<= 0.3', first_pass: '>= 70', p90_hours_to_merge: '<= 8', escaped: '<= 0' }; // the defaults
  assert.deepEqual(decode(empty.stdout).metrics, ['defects', 'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'merged', 'first_pass',
    'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped']
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
  assert.deepEqual(run.metrics, [['defects', 2, 1, '<= 1', 'missed'], ['tool_error_rate', 0.5, 0.75, '<= 0.05', 'missed'],
    ['corrections_per_session', 0.25, 1, '<= 0.3', 'met'], ['interrupts', 1, 0, '> 1', 'missed'], ['retries', 1, 0, '', ''],
    ...['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped']
      .map((name) => [name, 'n/a', 'n/a', { first_pass: '>= 70', p90_hours_to_merge: '<= 8', escaped: '<= 0' }[name] ?? '', name in { first_pass: 1, p90_hours_to_merge: 1, escaped: 1 } ? 'n/a' : '']),
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
  assert.deepEqual(signals, { correction: 4, interrupt: 1, retry: 1, test_fail: 2, tool_error: 6 }); // every stored event; a reply after an error is not a correction, a later success does not clear it
  const sub = query(p, `SELECT session_id, tool, signal FROM events WHERE run_id = ? AND ref LIKE '%/subagents/agent-a1.jsonl:%' AND kind = 'tool_result'`, id);
  assert.deepEqual(sub, [{ session_id: 's-main', tool: 'Grep', signal: 'tool_error' }]); // a subagent file is read
  assert.deepEqual(query(p, `SELECT exit_code FROM events WHERE run_id = ? AND signal = 'test_fail'`, id).map((e) => e.exit_code), [1, 1]);

  // Every planted shape is redacted in the excerpts (a tool error, the retried call's input, a correction), all
  // within the kept 300 characters, and no planted value reaches the store, state or output.
  for (const signal of ['test_fail', 'retry', 'correction']) {
    const [{ excerpt }] = query(p, 'SELECT excerpt FROM events WHERE run_id = ? AND signal = ? ORDER BY id LIMIT 1', id, signal);
    assert.ok(excerpt.includes(' END') && excerpt.includes('[redacted]') && excerpt.length <= 300, excerpt);
  }
  assertNoPlanted(p, [r, lfm('status', '--json'), lfm('runs'), lfm('ingest'), lfm('report', '--json'), lfm('report', '--full')]);
  assert.ok(!r.stdout.includes(claude) && !r.stdout.includes('UMER_FIXTURES'), 'no session path or text in the retro output');

  // A session id the run store recorded as the tool's own agent run is skipped next time; excerpts: off keeps none.
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.exec(`CREATE TABLE invocations (id INTEGER PRIMARY KEY, session_id TEXT); INSERT INTO invocations (session_id) VALUES ('s-own')`);
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

test('two defect logs of one type sum into defects; a config with only a no-mistakes source gives n/a for every sessions, defect and PR number', () => {
  const { p, lfm } = setup();
  const cfg = join(p, '.learn-from-mistakes.yaml');
  writeFileSync(join(p, 'a.md'), `## ${day(1)}\n\n- [tests] A one.\n- [tests] A two.\n- [tests] A three.\n`);
  writeFileSync(join(p, 'b.md'), `## ${day(2)}\n\n- [build] B one.\n- [build] B two.\n`);
  writeFileSync(cfg, 'sources:\n  a: { type: markdown-log, path: a.md }\n  b: { type: markdown-log, path: b.md }\n');
  const logs = lfm('retro', '--foreground');
  assert.equal(logs.status, 0, logs.stderr);
  assert.deepEqual(decode(logs.stdout).metrics.find((m) => m.name === 'defects'), { name: 'defects', current: 5, previous: 0, target: '', met: '' });

  writeFileSync(cfg, 'sources:\n  gate: { type: no-mistakes, path: gate.sqlite }\n');
  const gate = lfm('retro', '--foreground');
  assert.equal(gate.status, 0, gate.stderr);
  assert.deepEqual(decode(gate.stdout).metrics.map(({ name, current, previous }) => ({ name, current, previous })), ['defects', 'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'merged', 'first_pass',
    'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped']
    .map((name) => ({ name, current: 'n/a', previous: 'n/a' })));
});

test('a rule tags signal events only, and text_contains reads a retried call as its plain command text', () => {
  const { p, claude, lfm } = setup();
  const now = new Date().toISOString();
  const cwd = p;
  const call = (id, command) => ({ type: 'assistant', cwd, timestamp: now, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id, content, is_error) => ({ type: 'user', cwd, timestamp: now, message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(is_error && { is_error }) }] } });
  const quoted = 'grep "a b" x';
  writeFileSync(join(claude, 'projects', '-repo', 's-fix.jsonl'), [
    call('a1', 'ls'), result('a1', 'ok'),
    call('a2', quoted), result('a2', 'Exit code 1\nno match', true),
    call('a3', quoted), result('a3', 'ok'),
  ].map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `sources:
  sessions: { type: sessions }
causes:
  quoted-grep:
    description: A retried grep with quotes.
    match: { source: sessions, text_contains: 'grep "a b"' }
  bash-fail:
    description: A Bash call that fails.
    match: { source: sessions, tool: Bash }
`);
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(query(p, `SELECT cause, signal, tool, count(*) AS n FROM events WHERE run_id = ? AND session_id = 's-fix' AND cause IS NOT NULL GROUP BY cause, signal ORDER BY cause`, decode(r.stdout).run.id),
    [{ cause: 'bash-fail', signal: 'nonzero_exit', tool: 'Bash', n: 1 }, { cause: 'quoted-grep', signal: 'retry', tool: 'Bash', n: 1 }]);
});

test('a gate row takes one cause, the first in config order, in both the metrics and the report', () => {
  const { p, lfm } = setup();
  const gate = new DatabaseSync(join(p, 'gate.sqlite'));
  const failed = gate.prepare(`UPDATE step_results SET error = 'wait delay expired after timeout', completed_at = ? WHERE status = 'failed'`)
    .run(Math.floor(Date.now() / 1000)).changes;
  gate.close();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `sources:
  gate: { type: no-mistakes, path: gate.sqlite }
causes:
  timeout-hit:
    description: A timeout.
    match: { source: gate, error_contains: timeout }
  wait-delay:
    description: A wait delay.
    match: { source: gate, error_contains: 'wait delay' }
`);
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  const count = (name) => decode(r.stdout).metrics.find((m) => m.name === `cause_count:${name}`).current;
  assert.equal(count('timeout-hit'), failed);
  assert.equal(count('wait-delay'), 0);
  const report = JSON.parse(lfm('report', '--json').stdout);
  assert.equal(report.causes.find((c) => c.cause === 'timeout-hit').store.rows, failed);
  assert.equal(report.causes.find((c) => c.cause === 'wait-delay')?.store.rows ?? 0, 0);
});

// An OpenCode store: sessions [id, directory, messages, { parent, at }], each message [role, parts, error name].
function opencodeDb(file, sessions) {
  mkdirSync(join(file, '..'), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)`);
  let n = 0;
  for (const [id, directory, messages, { parent = null, at = Date.now() - 86_400_000 } = {}] of sessions) {
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(id, parent, directory, at, at + 60_000);
    for (const [role, parts, error] of messages) {
      const m = `msg_${String((n += 1)).padStart(3, '0')}`;
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(m, id, at + n, JSON.stringify({ role, ...(error && { error: { name: error, data: {} } }) }));
      for (const part of parts) db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(`prt_${String((n += 1)).padStart(3, '0')}`, m, id, at + n, typeof part === 'string' ? part : JSON.stringify(part));
    }
  }
  db.close();
}
const text = (t, extra) => ({ type: 'text', text: t, ...extra });
const tool = (name, input, state) => ({ type: 'tool', tool: name, callID: `call-${name}`, state: { input, ...state } });
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('a retro reads this repo\'s Codex and OpenCode sessions read-only and keeps planted secrets out', () => {
  const { tmp, p, tree, env, fill, lfm } = setup();
  const codex = join(env.CODEX_HOME, 'sessions'), src = new URL('fixtures/sessions/codex/sessions', import.meta.url).pathname;
  for (const f of readdirSync(src, { recursive: true })) {
    if (!f.endsWith('.jsonl')) continue;
    mkdirSync(join(codex, f, '..'), { recursive: true });
    writeFileSync(join(codex, f), fill(readFileSync(join(src, f), 'utf8')));
  }
  const rollout = (id) => join(codex, '2026', '10', '02', `rollout-${id}.jsonl`), old = new Date(Date.now() - 60 * 86_400_000);
  utimesSync(rollout('cx-old'), old, old);
  const threads = new DatabaseSync(join(env.CODEX_HOME, 'state_5.sqlite'));
  threads.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL, cwd TEXT NOT NULL)');
  for (const [i, [id, file, cwd, source = 'cli']] of [['cx-main', 'cx-main', p], ['cx-sub', 'cx-sub', p, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'cx-main', depth: 1 } } })],
    ['cx-tree', 'cx-tree', join(tree, 'src'), 'exec'], ['cx-marker', 'cx-marker', p], ['cx-other', 'cx-other', join(tmp, 'elsewhere')],
    ['cx-lfm', 'cx-other', join(p, '.lfm', 'runs', '1')], ['cx-old', 'cx-old', p], ['cx-gone', 'cx-gone', p]].entries()) {
    threads.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(id, rollout(file), 1_000 + i, source, cwd);
  }
  threads.close();

  const secrets = (from, to) => PLANTED.slice(from, to).map(([t]) => t).join(' ');
  const oc = join(env.XDG_DATA_HOME, 'opencode'), failing = [['user', [text('Umer: run it.')]], ['assistant', [tool('bash', { command: 'false' }, { status: 'completed', output: '', metadata: { exit: 1 } })]]];
  opencodeDb(join(oc, 'opencode.db'), [
    ['oc-main', p, [
      ['user', [text('Umer: the lint fails, fix it.')]],
      ['assistant', [tool('bash', { command: 'npm run lint' }, { status: 'completed', output: '1 problem', metadata: { exit: 1 } }),
        tool('read', { filePath: 'a.js' }, { status: 'error', error: `${secrets(0, -10)} END` })]],
      ['user', [text('Called the Read tool', { synthetic: true }), text(`Umer: use src/a.js, ${secrets(-10)} END`)]],
      ['assistant', [text('Reading src/a.js.'), tool('read', { filePath: 'a.js' }, { status: 'completed', output: 'ok' })]],
      ['user', [{ type: 'text' }, { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==' }]],
      ['assistant', [tool('bash', { command: 'sleep 100' }, { status: 'error', error: 'Tool execution aborted' })], 'MessageAbortedError'],
      ['user', [text('Umer: wait, use the other script.')]], // after an interrupt, not a correction
      ['assistant', [tool('bash', { command: 'npx vitest run' }, { status: 'error', error: 'vitest crashed' }), tool('bash', { command: 'ls' }, { status: 'running' }), '{not json']],
    ]],
    ['oc-sub', p, [['user', [text('Find the loader.')]], ['assistant', [tool('edit', { filePath: 'b.js' }, { status: 'error', error: 'Could not find oldString' })]],
      ['user', [text('Try src/.')]]], { parent: 'oc-main' }],
    ['oc-marker', p, [['user', [text('prompt-3.md', { synthetic: true }), { type: 'file', filename: 'prompt-3.md' }, text('"lfm-run:3:verify Follow the instructions in the attached file."')]], ...failing.slice(1)]],
    ['oc-other', join(tmp, 'elsewhere'), failing], ['oc-lfm', join(p, '.lfm', 'runs', '2'), failing],
    ['oc-old', p, failing, { at: Date.now() - 60 * 86_400_000 }],
  ]);
  opencodeDb(join(oc, 'channel.db'), [['oc-tree', tree, [['user', [text('Umer: hi')]], ['assistant', [text('Hello.')]]]]]);
  const notes = new DatabaseSync(join(oc, 'notes.db')); // another program's database in the same dir
  notes.exec('CREATE TABLE notes (body TEXT)');
  notes.close();
  const stores = ['opencode.db', 'channel.db', 'notes.db'].map((f) => join(oc, f)), before = stores.map(sha);

  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  sessions: { type: sessions, agents: [codex, opencode] }\n');
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  const run = decode(r.stdout);
  // this repo, a worktree subdir and a subagent of a kept session; not the other dir, .lfm/, the marker run, an old
  // session, a missing rollout or another program's database. Bad records: a non-JSON line, a non-JSON part and a text
  // part with no text.
  assert.deepEqual(run.sources.find((s) => s.type === 'sessions'), { id: 'sessions', type: 'sessions', items: 64, sessions: 4, skipped: 3 });
  assert.deepEqual(Object.fromEntries(run.metrics.filter((m) => ['tool_error_rate', 'corrections_per_session', 'interrupts', 'retries'].includes(m.name)).map((m) => [m.name, m.current])),
    { tool_error_rate: 0.542, corrections_per_session: 0.5, interrupts: 2, retries: 2 });
  const id = run.run.id;
  assert.deepEqual(query(p, 'SELECT agent, session_id, count(*) AS n FROM events WHERE run_id = ? GROUP BY 1, 2 ORDER BY 1, 2', id),
    [{ agent: 'codex', session_id: 'cx-main', n: 35 }, { agent: 'codex', session_id: 'cx-tree', n: 8 }, { agent: 'opencode', session_id: 'oc-main', n: 19 }, { agent: 'opencode', session_id: 'oc-tree', n: 2 }]);
  const signals = query(p, 'SELECT agent, signal, count(*) AS n FROM events WHERE run_id = ? AND signal IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2', id);
  // The goal wrapper and the message after an interrupt are not corrections; a failed patch and a failed exec script are.
  assert.deepEqual(signals.map((e) => `${e.agent} ${e.signal} ${e.n}`), ['codex correction 1', 'codex interrupt 1', 'codex nonzero_exit 3', 'codex retry 1', 'codex test_fail 3', 'codex tool_error 3',
    'opencode correction 1', 'opencode interrupt 1', 'opencode nonzero_exit 1', 'opencode retry 1', 'opencode test_fail 1', 'opencode tool_error 2']);
  assert.deepEqual(query(p, `SELECT tool, exit_code FROM events WHERE run_id = ? AND signal IN ('test_fail', 'nonzero_exit') ORDER BY id`, id),
    [{ tool: 'exec_command', exit_code: 1 }, { tool: 'exec_command', exit_code: 2 }, { tool: 'exec', exit_code: 1 }, { tool: 'exec_command', exit_code: 2 }, { tool: 'local_shell_call', exit_code: 1 }, { tool: 'exec_command', exit_code: 1 }, { tool: 'bash', exit_code: 1 }, { tool: 'bash', exit_code: null }]);
  // A successful exec_command whose output has "Exit code: 2" or a JSON "exit_code" body is not an error; a failed
  // apply_patch naming npm test is a tool error, not a test failure; a non-shell tool's "Exit code: 1" after Output: or
  // an MCP function's JSON exit_code is not read as an exit.
  assert.deepEqual(query(p, `SELECT status, signal, exit_code FROM events WHERE run_id = ? AND kind = 'tool_result' AND (ref GLOB '*rollout-cx-main.jsonl:2[1-9]' OR ref GLOB '*rollout-cx-main.jsonl:3[0-3]') ORDER BY id`, id),
    [{ status: 'ok', signal: null, exit_code: 0 }, { status: 'ok', signal: null, exit_code: 0 }, { status: 'error', signal: 'tool_error', exit_code: null },
      { status: 'error', signal: 'tool_error', exit_code: null }, { status: 'ok', signal: null, exit_code: null }, { status: 'ok', signal: null, exit_code: null }]);
  assert.deepEqual(query(p, `SELECT session_id, signal FROM events WHERE run_id = ? AND (ref LIKE '%rollout-cx-sub.jsonl:%' OR ref LIKE '%:part:%' AND session_id = 'oc-main' AND tool = 'edit') AND kind = 'tool_result'`, id),
    [{ session_id: 'cx-main', signal: 'nonzero_exit' }, { session_id: 'oc-main', signal: 'tool_error' }]); // subagents count in their parent session
  for (const [agent, signal] of [['codex', 'test_fail'], ['codex', 'correction'], ['opencode', 'tool_error'], ['opencode', 'correction']]) {
    const [{ excerpt }] = query(p, 'SELECT excerpt FROM events WHERE run_id = ? AND agent = ? AND signal = ? ORDER BY id LIMIT 1', id, agent, signal);
    assert.ok(excerpt.includes(' END') && excerpt.includes('[redacted]') && excerpt.length <= 300, excerpt);
  }
  assert.deepEqual(query(p, `SELECT agent, excerpt FROM events WHERE run_id = ? AND signal = 'retry' ORDER BY agent`, id),
    [{ agent: 'codex', excerpt: 'cat missing.txt' }, { agent: 'opencode', excerpt: 'a.js' }]); // a retried call's input as plain text
  assertNoPlanted(p, [r, lfm('status', '--json'), lfm('report', '--full')]);

  // A session id the run store recorded as the tool's own agent run is skipped next time, for each agent.
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.exec(`CREATE TABLE invocations (id INTEGER PRIMARY KEY, session_id TEXT); INSERT INTO invocations (session_id) VALUES ('cx-main'), ('oc-main')`);
  db.close();
  const again = lfm('retro', '--foreground', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).sources.find((s) => s.type === 'sessions').sessions, 2);
  assert.deepEqual(stores.map(sha), before, 'a session store changed');
});

test('a Codex state store that is not a database fails the retro with an error naming codex', () => {
  const { p, env, lfm } = setup();
  mkdirSync(env.CODEX_HOME, { recursive: true });
  writeFileSync(join(env.CODEX_HOME, 'state_5.sqlite'), 'not a sqlite database\n'.repeat(64));
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  sessions: { type: sessions, agents: [codex] }\n');
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes(`cannot read a codex session store at ${join(env.CODEX_HOME, 'state_5.sqlite')}`), r.stderr);
});

test('an OpenCode store that is not a database fails the retro with an error naming opencode', () => {
  const { p, env, lfm } = setup();
  mkdirSync(join(env.XDG_DATA_HOME, 'opencode'), { recursive: true });
  writeFileSync(join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'), 'not a sqlite database\n'.repeat(64));
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  sessions: { type: sessions, agents: [opencode] }\n');
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes(`cannot read a opencode session store at ${join(env.XDG_DATA_HOME, 'opencode', 'opencode.db')}`), r.stderr);
});

test('a target compares the unrounded ratio: 25 failed results of 496 miss "<= 0.05", shown as 0.05', () => {
  const { p, claude, lfm } = setup();
  rmSync(join(claude, 'projects'), { recursive: true });
  const now = new Date().toISOString();
  const call = (id) => ({ type: 'assistant', cwd: p, timestamp: now, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `${id}.txt` } }] } });
  const result = (id, i) => ({ type: 'user', cwd: p, timestamp: now, message: { content: [{ type: 'tool_result', tool_use_id: id, content: i < 25 ? 'File does not exist.' : 'ok', ...(i < 25 && { is_error: true }) }] } });
  const ids = Array.from({ length: 496 }, (_, i) => `t${i}`);
  mkdirSync(join(claude, 'projects', '-repo'), { recursive: true });
  writeFileSync(join(claude, 'projects', '-repo', 's-rate.jsonl'), ids.flatMap((id, i) => [call(id), result(id, i)]).map((r) => JSON.stringify(r)).join('\n'));
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  sessions: { type: sessions }\ntargets: { tool_error_rate: "<= 0.05" }\n');
  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  const row = decode(r.stdout).metrics.find((m) => m.name === 'tool_error_rate');
  assert.equal(row.current, 0.05);
  assert.equal(row.target, '<= 0.05');
  assert.equal(row.met, 'missed');
  const [stored] = query(p, `SELECT value, target FROM metrics WHERE run_id = ? AND name = 'tool_error_rate' AND window = 'current'`, decode(r.stdout).run.id);
  assert.deepEqual(stored, { value: 25 / 496, target: '<= 0.05' });
  const status = decode(lfm('status', '--run', String(decode(r.stdout).run.id)).stdout);
  assert.equal(status.metrics.find((m) => m.name === 'tool_error_rate').met, 'missed');
});

test('the bundle has ids, refs and redacted excerpts, pointers and counts only with excerpts off, no other repo\'s rows, and keeps to its cap', () => {
  const { p, lfm, env } = setup();
  const cfg = join(p, '.learn-from-mistakes.yaml'), examples = readFileSync(cfg, 'utf8');
  // One defect bullet and one failed gate step of this repo per planted shape, and a failed step of another repo in the same store.
  const one = PLANTED.filter(([t]) => !t.includes('\n'));
  writeFileSync(join(p, 'defects.md'), `${readFileSync(join(p, 'defects.md'), 'utf8')}\n## ${day(0)}\n\n${one.map(([t]) => `- [deploy] Umer pasted ${t} and password=[redacted]hunter2rest, token=[redacted] here in the log.`).join('\n')}\n`);
  const gate = new DatabaseSync(join(p, 'gate.sqlite')), at = Math.floor(Date.now() / 1000) - 3600;
  const step = gate.prepare(`INSERT INTO step_results (id, run_id, step_name, status, error, started_at, completed_at) VALUES (?, ?, 'push', 'failed', ?, ?, ?)`);
  one.forEach(([t], i) => step.run(`step-planted-${i}`, 'run-a', `push: Umer's remote said ${t}`, at, at));
  gate.exec(`INSERT INTO repos VALUES ('repo-other', '/elsewhere/other', 'https://example.invalid/umer/other.git');
    INSERT INTO runs VALUES ('run-x', 'repo-other', 'feat/other')`);
  step.run('step-other', 'run-x', 'push: OTHER-REPO-CANARY', at, at);
  gate.close();
  const bundleOf = (r) => {
    assert.equal(r.status, 0, r.stderr);
    const { id } = decode(r.stdout).run;
    return { id, text: readFileSync(join(p, '.lfm', 'runs', String(id), 'bundle.md'), 'utf8') };
  };

  // The canaries are secret-shaped values, which redact() removes; with excerpts on, plain record text stays in the bundle by design.
  const on = bundleOf(lfm('retro', '--foreground'));
  for (const [, needle] of PLANTED) assert.ok(!on.text.includes(needle), `${needle} in bundle.md`);
  assert.ok(!on.text.includes('OTHER-REPO-CANARY') && !on.text.includes('step-other'), 'another repo\'s gate row in bundle.md');
  assert.deepEqual(query(p, `SELECT count(*) AS n FROM records WHERE text LIKE '%OTHER-REPO-CANARY%'`), [{ n: 0 }]); // never read at all
  const stored = query(p, `SELECT text FROM records WHERE run_id = ? AND source = 'gate'`, on.id).map((r) => r.text).join('\n');
  for (const [, needle] of one) assert.ok(!stored.includes(needle), `${needle} stored from a gate error`); // kept redacted
  assert.match(on.text, /^\| tool_error_rate \| 0\.5 \| 0\.75 \| <= 0\.05 \|$/m);
  assert.match(on.text, /^No follow-ups yet\.$/m);
  // Clusters by tool and signal, the largest first, each with its latest events; then the records no rule tagged.
  const clusters = [...on.text.matchAll(/^### \[c(\d+)\] .+: (\d+) events, \d+ sessions, \d+ days, causes: .+$/gm)];
  assert.deepEqual(clusters.map((c) => Number(c[1])), clusters.map((_, i) => i + 1));
  assert.deepEqual(clusters.map((c) => Number(c[2])), clusters.map((c) => Number(c[2])).toSorted((a, b) => b - a));
  assert.match(on.text, /^### \[c1\] Bash test_fail: 2 events, 1 sessions, 1 days, causes: fetch-test-fails$/m); // the failed Reads are in the last window
  const events = [...on.text.matchAll(/^- \[e(\d+)\] \S+ session s-\w+ at \S+\.jsonl:\d+$/gm)].map((m) => Number(m[1]));
  const records = [...on.text.matchAll(/^- \[([^\]]+)\] (?:log|gate) at \S+, [\d-]+$/gm)].map((m) => m[1]);
  assert.ok(events.length && records.length === 2 * one.length + 2, on.text); // the planted ones, and the two from yesterday
  assert.equal(query(p, `SELECT count(*) AS n FROM events WHERE run_id = ? AND id IN (${events})`, on.id)[0].n, events.length); // ids are store rows
  const quotes = on.text.match(/^  > .+$/gm);
  assert.ok(quotes.every((q) => q.length <= 304), 'an excerpt over 300 characters');
  assert.equal(on.text.match(/^- \[(?!e\d+\])[^\]]+\] .+\n  > .+$/gm).length, records.length, 'a record without its excerpt');
  assert.match(on.text, /^- \[e\d+\] .+\n  > Exit code 1 FAIL test\/fetch\.test\.js$/m); // an event's excerpt
  assert.ok(quotes.filter((q) => q.includes('[redacted]')).length >= 2 * one.length);
  assert.ok(!on.text.includes('[redacted]]'), 'a placeholder redacted twice');
  assert.ok(!on.text.includes('hunter2rest') && on.text.includes('password=[redacted] token=[redacted] here in the log.'), 'a secret after a placeholder, or a placeholder redacted again');

  // The bundle step is interrupted after metrics; the config then changes its target. The resumed bundle shows the target the metrics step stored.
  const bundlePath = join(p, '.lfm', 'runs', String(on.id), 'bundle.md');
  const interrupt = (...names) => {
    const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
    db.exec(`UPDATE runs SET status = 'interrupted' WHERE id = ${on.id}`);
    for (const name of names) db.prepare(`UPDATE steps SET status = 'interrupted' WHERE run_id = ? AND name = ?`).run(on.id, name);
    db.close();
  };
  interrupt('bundle');
  writeFileSync(cfg, examples.replace('targets: { ', 'targets: { tool_error_rate: "<= 0.1", '));
  let resumed = lfm('rerun', '--resume', '--run', String(on.id), '--wait', '1m');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(readFileSync(bundlePath, 'utf8'), /^\| tool_error_rate \| 0\.5 \| 0\.75 \| <= 0\.05 \|$/m);

  // A collect rerun reads the records again; each record id the bundle cites is one labels.jsonl takes, and a label names it.
  interrupt('collect', 'metrics', 'bundle', 'report');
  resumed = lfm('rerun', '--resume', '--run', String(on.id), '--wait', '1m');
  assert.equal(resumed.status, 0, resumed.stderr);
  const ledger = (file) => readFileSync(join(p, '.lfm', file), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const recordIds = new Set(ledger('records.jsonl').map((r) => r.id));
  const cited = [...readFileSync(bundlePath, 'utf8').matchAll(/^- \[([^\]]+)\] (log|gate) at /gm)];
  assert.equal(cited.length, records.length);
  for (const [, id, source] of cited) assert.ok(recordIds.has(id), `[${id}] is not a ${source} id of records.jsonl`);
  for (const [, needle] of PLANTED) assert.ok(!readFileSync(join(p, '.lfm', 'records.jsonl'), 'utf8').includes(needle), `${needle} in records.jsonl`);
  const label = (id) => {
    writeFileSync(join(p, '.lfm', 'labels.jsonl'), JSON.stringify({ id, event: false, why: 'a fix note' }) + '\n');
    return lfm('report');
  };
  const gateId = cited.find(([, , source]) => source === 'gate')[1];
  assert.equal(label(gateId).status, 0, `a cited gate id is not accepted by labels.jsonl`);
  assert.match(label('gate:step-missing').stderr, /unknown record id/);
  rmSync(join(p, '.lfm', 'labels.jsonl'));

  // excerpts: off: the same items as pointers and counts, and no text of any record or event.
  writeFileSync(cfg, `${examples}excerpts: off\n`);
  const off = bundleOf(lfm('retro', '--foreground'));
  assert.doesNotMatch(off.text, /^  > /m);
  const offRecords = ledger('records.jsonl');
  assert.ok(offRecords.some((r) => r.source === 'gate') && offRecords.some((r) => r.source === 'log'));
  assert.ok(offRecords.every((r) => !('text' in r)), 'record text in records.jsonl with excerpts off');
  const offRows = readFileSync(join(p, '.lfm', 'rows.jsonl'), 'utf8');
  assert.ok(offRows.includes('step-planted-0'));
  for (const [, needle] of PLANTED) assert.ok(!offRows.includes(needle), `${needle} in rows.jsonl with excerpts off`);
  assert.ok(!offRows.includes('remote said'), 'gate error text in rows.jsonl with excerpts off');
  const texts = [...query(p, 'SELECT text FROM records WHERE run_id = ?', on.id).map((r) => r.text), ...query(p, `SELECT excerpt AS text FROM events WHERE run_id = ? AND excerpt != ''`, on.id).map((r) => r.text)];
  for (const t of texts) if (t.length >= 16) assert.ok(!off.text.includes(t.slice(0, 16)), `"${t.slice(0, 16)}" in bundle.md with excerpts off`);
  assert.ok(!off.text.includes('[redacted]') && !off.text.includes('Umer'));
  assert.equal([...off.text.matchAll(/^- \[(?!e\d+\])[^\]]+\] /gm)].length, records.length);
  assert.equal([...off.text.matchAll(/^### \[c\d+\] /gm)].length, clusters.length);

  // A config in a subdirectory of the checkout counts this repo's gate rows, matched by its checkout, and no other repo's.
  const store = new DatabaseSync(join(p, 'gate.sqlite'));
  store.prepare('UPDATE repos SET working_path = ?, upstream_url = ? WHERE working_path = ?').run(realpathSync(p), 'https://example.invalid/umer/moved.git', '/elsewhere/p');
  const mine = store.prepare(`SELECT count(*) AS n FROM step_results s JOIN runs r ON r.id = s.run_id JOIN repos o ON o.id = r.repo_id
    WHERE s.status = 'failed' AND o.working_path = ?`).get(realpathSync(p)).n;
  store.close();
  const sub = join(p, 'app');
  mkdirSync(sub);
  writeFileSync(join(sub, '.learn-from-mistakes.yaml'), `sources:\n  gate: { type: no-mistakes, path: ${join(p, 'gate.sqlite')} }\n`);
  const nested = spawnSync(process.execPath, [CLI, 'retro', '--foreground', '--dir', sub], { encoding: 'utf8', env });
  assert.equal(nested.status, 0, nested.stderr);
  assert.ok(mine > 0, 'no failed gate step of this repo');
  assert.equal(decode(nested.stdout).sources.find((s) => s.type === 'no-mistakes').items, mine);

  // The cap: items that would pass it are dropped, and counted.
  writeFileSync(cfg, `${examples}caps: { bundle_chars: 1000 }\n`);
  const capped = bundleOf(lfm('retro', '--foreground'));
  assert.ok(capped.text.length <= 1000, `${capped.text.length} characters`);
  const more = Array.from({ length: 40 }, (_, i) => `  c${i}: { description: d }\n`).join('');
  writeFileSync(cfg, `${examples.replace('causes:\n', `causes:\n${more}`)}caps: { bundle_chars: 1000 }\n`);
  const metricsOnly = bundleOf(lfm('retro', '--foreground')); // the metrics fill it; the later headings still fit
  assert.ok(metricsOnly.text.length <= 1000 && metricsOnly.text.includes('## Unlabelled defect records'), `${metricsOnly.text.length} characters`);
  assert.match(capped.text, /^Dropped \d+ items to keep the bundle under 1000 characters\.$/m);
  for (let cap = 1000; cap <= 4000; cap += 150) { // once a cluster does not fit, no smaller one below it is admitted
    writeFileSync(cfg, `${examples}caps: { bundle_chars: ${cap} }\n`);
    const b = bundleOf(lfm('retro', '--foreground'));
    const nums = [...b.text.matchAll(/^### \[c(\d+)\]/gm)].map((c) => Number(c[1]));
    assert.deepEqual(nums, nums.map((_, i) => i + 1), `clusters ${nums} under ${cap}`);
    assert.ok(b.text.length <= cap, `${b.text.length} characters under ${cap}`);
  }
  writeFileSync(cfg, `${examples}caps: { bundle_chars: 999 }\n`);
  assert.match(lfm('retro', '--foreground').stderr, /caps\.bundle_chars must be at least 1000$/m);
});
