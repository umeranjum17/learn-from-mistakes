// End-to-end: a retro with a sessions source reads a synthetic Claude Code store (test/fixtures/sessions/claude),
// counts only this repo's sessions, skips the tool's own runs, and keeps planted secrets out of the store and output.
// Its metrics step gives the numbers for this window and the last, with the events the cause match rules tagged.
// LFM_CLI points the same journey at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  const env = { ...process.env, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm'), CLAUDE_CONFIG_DIR: claude };
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  return { tmp, p, claude, env, lfm };
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
  assert.deepEqual(decode(empty.stdout).metrics, ['defects', 'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'first_pass', 'p90_hours_to_merge', 'escaped']
    .map((name) => ({ name, current: 'n/a', previous: 'n/a', target: TARGETS[name] ?? '', met: TARGETS[name] ? 'n/a' : '' }))); // the numbers of the types with no source here, then the targets no source measures; n/a is never met or missed

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
    ['cause_count:fetch-test-fails', 1, 0, '<= 1', 'met'], ['cause_count:missing-file', 0, 3, '= 0', 'met'], ['cause_count:server-memory-kill', 'n/a', 'n/a', '<= 0', 'n/a'],
    ['cause_count:shared-cache-lock', 'n/a', 'n/a', '', ''], ['cause_count:agent-exit-wait', 0, 0, '', ''], ['first_pass', 'n/a', 'n/a', '>= 70', 'n/a'],
    ['p90_hours_to_merge', 'n/a', 'n/a', '<= 8', 'n/a'], ['escaped', 'n/a', 'n/a', '<= 0', 'n/a']]
    .map(([name, current, previous, target, met]) => ({ name, current, previous, target, met })));
  assert.equal(Date.parse(run.window.current_start) - Date.parse(run.window.previous_start), 7 * 86_400_000);
  assert.deepEqual(query(p, `SELECT window, value FROM metrics WHERE run_id = ? AND name IN ('defects', 'escaped') ORDER BY name, window`, id),
    [{ window: 'current', value: 2 }, { window: 'previous', value: 1 }, { window: 'current', value: null }, { window: 'previous', value: null }]); // n/a is NULL
  // The store keeps the target and the comparison for both windows: 1 met, 0 missed, NULL n/a or no target.
  assert.deepEqual(query(p, `SELECT window, target, met FROM metrics WHERE run_id = ? AND name IN ('defects', 'escaped', 'retries') ORDER BY name, window`, id),
    [{ window: 'current', target: '<= 1', met: 0 }, { window: 'previous', target: '<= 1', met: 1 }, { window: 'current', target: '<= 0', met: null },
      { window: 'previous', target: '<= 0', met: null }, { window: 'current', target: null, met: null }, { window: 'previous', target: null, met: null }]);
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
  const outputs = [r, lfm('status', '--json'), lfm('runs'), lfm('ingest'), lfm('report', '--json'), lfm('report', '--full')];
  const state = readdirSync(join(p, '.lfm'), { recursive: true }).map((f) => { try { return readFileSync(join(p, '.lfm', f), 'latin1'); } catch { return ''; } });
  for (const [, needle] of PLANTED) {
    for (const o of outputs) assert.ok(!o.stdout.includes(needle) && !o.stderr.includes(needle), `${needle} in output`);
    for (const bytes of state) assert.ok(!bytes.includes(needle), `${needle} in .lfm`);
  }
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

test('two defect logs of one type sum into defects; a config with only a no-mistakes source gives n/a for every sessions and defect number', () => {
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
  assert.deepEqual(decode(gate.stdout).metrics.map(({ name, current, previous }) => ({ name, current, previous })), ['defects', 'tool_error_rate', 'corrections_per_session', 'interrupts', 'retries', 'first_pass', 'p90_hours_to_merge', 'escaped']
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
