// End-to-end: a retro's followup step gives each applied change its metric before and after the change, from
// synthetic Claude Code sessions, and a verdict by the rules in src/followup.mjs; a second retro applies the
// rules that need two retros in a row, and a rerun over the same data does not count as one. LFM_CLI points the same
// journey at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';
// The user's agents, set once in the throwaway global config: a run needs both and the tool never picks one.
const AGENTS_SET = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const FAKE_AGENT = new URL('fake-agent/claude', import.meta.url).pathname;
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// A project with synthetic sessions, a defect log and eleven applied changes; returns its dir and the CLI runner.
function journey() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-followup-'));
  after(() => rmSync(tmp, { recursive: true }));
  const p = join(tmp, 'p'), store = join(tmp, 'home', '.claude', 'projects', '-p');
  mkdirSync(p);
  mkdirSync(store, { recursive: true });
  // A session `days` ago in the project, whose calls of each named tool fail.
  const session = (id, days, tools) => {
    const at = { cwd: p, sessionId: id, timestamp: ago(days) }, file = join(store, `${id}.jsonl`);
    writeFileSync(file, [{ type: 'user', ...at, message: { role: 'user', content: 'Umer: tidy the docs.' } }, ...tools.flatMap((name, i) => [
      { type: 'assistant', ...at, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: { path: `f${i}` } }] } },
      { type: 'user', ...at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true, content: 'No such file.' }] } }])]
      .map((r) => JSON.stringify(r)).join('\n') + '\n');
    return file;
  };
  const fail = (n, tool) => Array(n).fill(tool);
  // Before the changes, 5 days ago: 4 failed Reads, Greps and Edits, 2 failed Globs. After them, 2 days ago: 3 sessions with
  // 5 failed Greps, 2 Globs and 2 Edits; half a day ago one more session with no failure.
  session('s-before', 5, [...fail(4, 'Read'), ...fail(4, 'Grep'), ...fail(2, 'Glob'), ...fail(4, 'Edit')]);
  session('s-a1', 2, [...fail(3, 'Grep'), 'Glob', 'Edit']);
  session('s-a2', 2, [...fail(2, 'Grep'), 'Glob', 'Edit']);
  session('s-a3', 2, []);
  session('s-late', 0.5, []);
  // 5 days ago, 4 failed Writes; 2 days ago, 4 more: the before and after numbers of a met rule change.
  session('s-write-before', 5, fail(4, 'Write'));
  session('s-write-after', 2, fail(4, 'Write'));
  // 20 days ago, older than both windows: 2 failed Reads. Only a change 15 days ago reaches back to them.
  const old = new Date(Date.now() - 20 * DAY);
  utimesSync(session('s-old', 20, fail(2, 'Read')), old, old);

  const rule = (tool) => `{ description: The agent's ${tool} calls fail., match: { source: sessions, signal: tool_error, tool: ${tool} } }`;
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `worker: { runner: claude }
sources:
  sessions: { type: sessions, agents: [claude] }
  defects: { type: markdown-log, path: defects.md }
causes:
  missing-file: ${rule('Read')}
  bad-search: ${rule('Grep')}
  bad-glob: ${rule('Glob')}
  bad-edit: ${rule('Edit')}
  bad-write: ${rule('Write')}
  no-rule: { description: Nothing tags it. }
followup: { min_sessions: 3, min_days: 1 }
`);
  // A defect log whose first record is 4 days ago: a change 6 days ago has no record on or before its before window's start.
  writeFileSync(join(p, 'defects.md'), `## ${ago(4).slice(0, 10)}\n\n- A defect after the change.\n`);
  // PATH holds the fake agent (the analyse step's worker), node for its #! line, and git.
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  symlinkSync(FAKE_AGENT, join(bin, 'claude'));
  symlinkSync(process.execPath, join(bin, 'node'));
  symlinkSync(process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync), join(bin, 'git'));
  const env = { ...process.env, PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm'), CLAUDE_CONFIG_DIR: join(tmp, 'home', '.claude'),
    CODEX_HOME: join(tmp, 'home', '.codex'), XDG_DATA_HOME: join(tmp, 'home', '.local', 'share') };
  mkdirSync(env.LFM_HOME, { recursive: true });
  writeFileSync(join(env.LFM_HOME, 'config.yaml'), AGENTS_SET);
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  const change = (cause, days, ...flags) => {
    const r = lfm('change', 'applied', '--cause', cause, '--ref', 'abc1234', '--at', ago(days), ...flags);
    assert.equal(r.status, 0, r.stderr);
  };
  change('missing-file', 3, '--tripwire', '<= 0'); // chg-1: 4 -> 0, keep
  change('bad-search', 3, '--tripwire', '<= 0'); // chg-2: 4 -> 5, worse: rollback
  change('bad-glob', 3, '--tripwire', '<= 0', '--kind', 'rule'); // chg-3: 2 -> 2, flat: rollback, then delete
  change('bad-edit', 3, '--tripwire', '<= 1'); // chg-4: 4 -> 2, better but missed: fix, then rollback
  change('missing-file', 1, '--tripwire', '<= 0'); // chg-5: one session after it: no-data
  change('no-rule', 3, '--tripwire', '<= 0'); // chg-6: no number for its metric: no-data
  change('missing-file', 3); // chg-7: no tripwire to check: no-data
  change('missing-file', 15, '--tripwire', '<= 0', '--kind', 'rule'); // chg-8: 2 -> 4 from the old session: rollback
  change('bad-glob', 3, '--kind', 'rule'); // chg-9: flat, no tripwire: no-data, then delete
  change('bad-write', 3, '--tripwire', '<= 4', '--kind', 'rule'); // chg-10: 4 -> 4, met: keep, also on the second retro
  change('no-rule', 6, '--metric', 'defects', '--tripwire', '<= 0'); // chg-11: the defect log has no record before its window: no-data

  const retro = () => {
    const r = lfm('retro', '--foreground', '--json');
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  return { p, lfm, retro };
}

// Moves a run's collect window back in time, as if that run had read `days` earlier.
function moveRunBack(p, id, days) {
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  const back = (iso) => new Date(Date.parse(iso) - days * DAY).toISOString();
  const { output_json } = db.prepare(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'collect'`).get(id);
  const out = JSON.parse(output_json);
  db.prepare(`UPDATE steps SET output_json = ? WHERE run_id = ? AND name = 'collect'`)
    .run(JSON.stringify({ ...out, current_start: back(out.current_start), previous_start: back(out.previous_start) }), id);
  db.close();
}

test('each applied change gets before and after numbers and a verdict; the second retro keeps a met rule change, deletes a flat one with or without a missed tripwire, and rolls back a second miss; a records source that does not cover the before window gives no-data', () => {
  const { p, lfm, retro } = journey();
  const first = retro();
  assert.deepEqual(first.steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['bundle', 'completed'], ['analyse', 'completed'], ['report', 'completed']]);
  const row = (change, metric, before, after, tripwire, verdict) => ({ change, metric, before, after, tripwire, verdict });
  assert.deepEqual(first.followups, [
    row('chg-1', 'cause_count:missing-file', 4, 0, '<= 0', 'keep'),
    row('chg-2', 'cause_count:bad-search', 4, 5, '<= 0', 'rollback'),
    row('chg-3', 'cause_count:bad-glob', 2, 2, '<= 0', 'rollback'),
    row('chg-4', 'cause_count:bad-edit', 4, 2, '<= 1', 'fix'),
    row('chg-5', 'cause_count:missing-file', 4, 0, '<= 0', 'no-data'),
    row('chg-6', 'cause_count:no-rule', 'n/a', 'n/a', '<= 0', 'no-data'),
    row('chg-7', 'cause_count:missing-file', 4, 0, '', 'no-data'),
    row('chg-8', 'cause_count:missing-file', 2, 4, '<= 0', 'rollback'),
    row('chg-9', 'cause_count:bad-glob', 2, 2, '', 'no-data'),
    row('chg-10', 'cause_count:bad-write', 4, 4, '<= 4', 'keep'),
    row('chg-11', 'defects', 'n/a', 1, '<= 0', 'no-data'),
  ]);
  // The first run becomes an earlier retro: it read 2 days back, more than min_days before the second one.
  moveRunBack(p, first.run.id, 2);
  const second = retro();
  assert.deepEqual(second.followups.map((f) => [f.change, f.verdict]), [['chg-1', 'keep'], ['chg-2', 'rollback'], ['chg-3', 'delete'],
    ['chg-4', 'rollback'], ['chg-5', 'no-data'], ['chg-6', 'no-data'], ['chg-7', 'no-data'], ['chg-8', 'rollback'], ['chg-9', 'delete'],
    ['chg-10', 'keep'], ['chg-11', 'no-data']]);
  assert.deepEqual(decode(lfm('status', '--run', String(first.run.id)).stdout).followups, first.followups); // each run keeps its own verdicts

  // The store keeps the unrounded numbers, NULL for n/a and for no tripwire; the follow-up step logs one line per change.
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true });
  const stored = db.prepare(`SELECT change_id, before, after, tripwire, verdict FROM followups WHERE run_id = ? AND change_id IN ('chg-6', 'chg-7') ORDER BY change_id`).all(second.run.id);
  db.close();
  assert.deepEqual(stored.map((r) => ({ ...r })), [{ change_id: 'chg-6', before: null, after: null, tripwire: '<= 0', verdict: 'no-data' },
    { change_id: 'chg-7', before: 4, after: 0, tripwire: null, verdict: 'no-data' }]);
  const log = JSON.parse(lfm('logs', '--step', 'followup', '--json').stdout);
  assert.deepEqual(log.log.slice(0, 2).map((l) => l.line), ['chg-1 cause_count:missing-file: 4 before, 0 after, keep', 'chg-2 cause_count:bad-search: 4 before, 5 after, rollback']);
});

test('a change added after collect with an at older than what collect read gives n/a numbers and no-data', () => {
  const { p, lfm, retro } = journey();
  const first = retro();
  for (const days of [20, 30]) {
    const r = lfm('change', 'applied', '--cause', 'missing-file', '--ref', 'abc1234', '--at', ago(days), '--tripwire', '<= 0');
    assert.equal(r.status, 0, r.stderr);
  }
  // The followup step failed after collect had read the ledger; `rerun --resume` runs it again with the new changes in the ledger.
  const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'));
  db.prepare(`UPDATE steps SET status = 'failed' WHERE run_id = ? AND name = 'followup'`).run(first.run.id);
  db.prepare(`UPDATE runs SET status = 'failed' WHERE id = ?`).run(first.run.id);
  db.close();
  const resumed = lfm('rerun', '--resume', '--run', String(first.run.id), '--wait', '1m', '--json');
  assert.equal(resumed.status, 0, resumed.stderr);
  const r = JSON.parse(resumed.stdout);
  assert.deepEqual(r.followups.slice(0, 11), first.followups); // the changes collect read keep their numbers and verdicts
  assert.deepEqual(r.followups.slice(11).map((f) => [f.change, f.before, f.after, f.verdict]), [['chg-12', 'n/a', 4, 'no-data'], ['chg-13', 'n/a', 'n/a', 'no-data']]);
});

test('two retros within a minute: no delete, and no missed-twice rollback', () => {
  const { retro } = journey();
  retro();
  const again = retro();
  assert.deepEqual(again.followups.map((f) => [f.change, f.verdict]), [['chg-1', 'keep'], ['chg-2', 'rollback'], ['chg-3', 'rollback'],
    ['chg-4', 'fix'], ['chg-5', 'no-data'], ['chg-6', 'no-data'], ['chg-7', 'no-data'], ['chg-8', 'rollback'], ['chg-9', 'no-data'],
    ['chg-10', 'keep'], ['chg-11', 'no-data']]);
});
