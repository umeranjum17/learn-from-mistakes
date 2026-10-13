// End-to-end: a retro's followup step gives each applied change its metric before and after the change, from
// synthetic Claude Code sessions, and a verdict by the rules in src/followup.mjs; a second retro applies the
// rules that need two retros in a row. LFM_CLI points the same journey at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

test('each applied change gets before and after numbers and a verdict; the second retro deletes a flat rule and rolls back a second miss', () => {
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
  // 20 days ago, older than both windows: 2 failed Reads. Only a change 15 days ago reaches back to them.
  const old = new Date(Date.now() - 20 * DAY);
  utimesSync(session('s-old', 20, fail(2, 'Read')), old, old);

  const rule = (tool) => `{ description: The agent's ${tool} calls fail., match: { source: sessions, signal: tool_error, tool: ${tool} } }`;
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `sources:
  sessions: { type: sessions, agents: [claude] }
causes:
  missing-file: ${rule('Read')}
  bad-search: ${rule('Grep')}
  bad-glob: ${rule('Glob')}
  bad-edit: ${rule('Edit')}
  no-rule: { description: Nothing tags it. }
followup: { min_sessions: 3, min_days: 1 }
`);
  const env = { ...process.env, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm'), CLAUDE_CONFIG_DIR: join(tmp, 'home', '.claude'),
    CODEX_HOME: join(tmp, 'home', '.codex'), XDG_DATA_HOME: join(tmp, 'home', '.local', 'share') };
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

  const retro = () => {
    const r = lfm('retro', '--foreground', '--json');
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const first = retro();
  assert.deepEqual(first.steps.map((s) => [s.name, s.status]), [['collect', 'completed'], ['metrics', 'completed'], ['followup', 'completed'], ['report', 'completed']]);
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
  ]);
  const second = retro();
  assert.deepEqual(second.followups.map((f) => [f.change, f.verdict]), [['chg-1', 'keep'], ['chg-2', 'rollback'], ['chg-3', 'delete'],
    ['chg-4', 'rollback'], ['chg-5', 'no-data'], ['chg-6', 'no-data'], ['chg-7', 'no-data'], ['chg-8', 'rollback']]);
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
