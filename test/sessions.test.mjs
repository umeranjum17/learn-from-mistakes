// End-to-end: a retro with a sessions source reads a synthetic Claude Code store (test/fixtures/sessions/claude),
// counts only this repo's sessions, skips the tool's own runs, and keeps planted secrets out of the store and output.
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
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('sources:\n', 'sources:\n  sessions: { type: sessions }\n'));
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
  assert.deepEqual(decode(empty.stdout).sources.find((s) => s.type === 'sessions'),
    { id: 'sessions', type: 'sessions', items: 0, sessions: 0, skipped: 0, metrics: { tool_error_rate: 'n/a', corrections_per_session: 'n/a', interrupts: 'n/a', retries: 'n/a' } });

  const r = lfm('retro', '--foreground');
  assert.equal(r.status, 0, r.stderr);
  const run = decode(r.stdout);
  assert.equal(run.run.status, 'completed');
  // this repo, a subdir and a worktree; not the other project, a sibling dir, .lfm/, the marker run or an old file
  assert.deepEqual(run.sources.find((s) => s.type === 'sessions'),
    { id: 'sessions', type: 'sessions', items: 25, sessions: 4, skipped: unreadable ? 3 : 2, metrics: { tool_error_rate: 0.5, corrections_per_session: 0.25, interrupts: 1, retries: 1 } });
  const id = run.run.id;
  assert.deepEqual(query(p, 'SELECT DISTINCT session_id FROM events WHERE run_id = ? ORDER BY 1', id).map((e) => e.session_id), ['s-main', 's-own', 's-sub', 's-tree']);
  const signals = Object.fromEntries(query(p, 'SELECT signal, count(*) AS n FROM events WHERE run_id = ? AND signal IS NOT NULL GROUP BY signal', id).map((e) => [e.signal, e.n]));
  assert.deepEqual(signals, { correction: 2, interrupt: 1, retry: 1, test_fail: 2, tool_error: 2 }); // one old error and correction are stored, not counted
  const sub = query(p, `SELECT session_id, tool, signal FROM events WHERE run_id = ? AND ref LIKE '%/subagents/agent-a1.jsonl:%' AND kind = 'tool_result'`, id);
  assert.deepEqual(sub, [{ session_id: 's-main', tool: 'Grep', signal: 'tool_error' }]); // a subagent file is read
  assert.deepEqual(query(p, `SELECT exit_code FROM events WHERE run_id = ? AND signal = 'test_fail'`, id).map((e) => e.exit_code), [1, 1]);

  // Every planted shape is redacted in the excerpts (a tool error, the retried call as JSON, a correction), all
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
  assert.deepEqual(query(p, 'SELECT count(*) AS n FROM events WHERE run_id = ?', id), [{ n: 25 }]); // the first run keeps its events
});
