// Forced-limit journey: a stub picker returns account A, then B, then a fallover route; the fake
// runner fails A with a quota error. Temp HOME only; no real board or real accounts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const FAKE = fileURLToPath(new URL('fake-agent/claude', import.meta.url));
const PICKER = fileURLToPath(new URL('fake-agent/account-picker', import.meta.url));
const AGENTS = 'agent: claude\njudge_agent: codex\nagent_config: { claude: { model: claude-haiku-5-5 }, codex: { model: gpt-6-luna } }\n';

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-picker-'));
  after(() => { /* leave temp folders in place */ });
  const p = join(tmp, 'p'), fakes = join(tmp, 'fakes'), user = join(tmp, 'user'), home = join(tmp, 'home'), folders = join(tmp, 'folders');
  cpSync(new URL('../examples', import.meta.url).pathname, p, { recursive: true });
  for (const d of [fakes, user, home, join(folders, 'pa_umer_a'), join(folders, 'pa_umer_b')]) mkdirSync(d, { recursive: true });
  for (const name of ['claude', 'codex']) symlinkSync(FAKE, join(fakes, name));
  writeFileSync(join(home, 'config.yaml'), AGENTS);
  const env = { ...process.env, PATH: `${fakes}${delimiter}${process.env.PATH}`, LFM_HOME: home, HOME: user,
    SIGN_OFF_HOME: user, TMPDIR: tmp, LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: tmp, PICKER_FOLDERS: folders };
  const lfm = (extra, ...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env: { ...env, ...extra } });
  const query = (sql, ...a) => { const db = new DatabaseSync(join(p, '.lfm', 'lfm.sqlite'), { readOnly: true }); try { return db.prepare(sql).all(...a).map((x) => ({ ...x })); } finally { db.close(); } };
  return { tmp, p, lfm, query };
}

const pickerEnv = (tmp, extra = {}) => ({
  ACCOUNT_PICKER: JSON.stringify([process.execPath, PICKER]),
  PICKER_LOG: join(tmp, 'picker.jsonl'),
  FAKE_QUOTA_ON: 'pa_umer_a',
  ...extra,
});

test('a quota on account A falls over to B; attempted grows; credits are refused; unset picker is unchanged', () => {
  const { tmp, p, lfm, query } = setup();
  const r = lfm(pickerEnv(tmp), 'agents', '--test', 'claude', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).test.account, 'pa_umer_b');
  const log = readFileSync(join(tmp, 'picker.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log[0].verb, 'pick');
  assert.deepEqual(log[0].req.attempted, []);
  assert.equal(log[1].verb, 'next');
  assert.deepEqual(log[1].req.attempted, ['pa_umer_a']);
  assert.equal(log[1].req.cause, 'quota');
  assert.equal(log[1].req.selection.id, 'pa_umer_a');
  assert.equal(log[0].req.deadline, log[1].req.deadline);

  const credits = lfm({ ...pickerEnv(tmp, { PICKER_LOG: join(tmp, 'credits.jsonl') }), PICKER_CREDITS: '1' }, 'agents', '--test', 'claude');
  assert.equal(credits.status, 1);
  assert.match(credits.stderr, /refused a usage-credits\/overage selection \(pa_credits\)/);

  const both = join(tmp, 'both-fail');
  writeFileSync(both, `#!/usr/bin/env node
const fs = require('node:fs');
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
if (process.env.PICKER_LOG) fs.appendFileSync(process.env.PICKER_LOG, JSON.stringify({ verb: process.argv.includes('next') ? 'next' : 'pick', attempted: req.attempted || [] }) + '\\n');
const attempted = req.attempted || [];
const emit = (id, extra = {}) => console.log(JSON.stringify({ ok: true, v: 1, id, selection_id: id, harness: extra.harness || 'claude', provider: extra.provider || 'claude', model: extra.model || req.model, set: extra.set ?? { LFM_ACCOUNT: id }, unset: [], billing: 'plan' }));
if (!attempted.includes('pa_umer_a')) emit('pa_umer_a');
else if (!attempted.includes('pa_umer_b')) emit('pa_umer_b');
else emit('route:cursor/auto', { harness: 'cursor', provider: 'cursor', model: 'auto', set: {} });
`);
  chmodSync(both, 0o755);
  const every = lfm({ ACCOUNT_PICKER: JSON.stringify([process.execPath, both]), PICKER_LOG: join(tmp, 'every.jsonl'), FAKE_QUOTA_ON: 'pa_umer_' }, 'agents', '--test', 'claude');
  assert.equal(every.status, 1, every.stderr);
  assert.match(every.stderr, /no runner for route route:cursor\/auto/);
  const everyLog = readFileSync(join(tmp, 'every.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(everyLog.some((e) => e.attempted.includes('pa_umer_a')) && everyLog.some((e) => e.attempted.includes('pa_umer_b')));

  const unset = lfm({}, 'agents', '--test', 'claude', '--json');
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(JSON.parse(unset.stdout).test.account, undefined);
  assert.ok(!existsSync(join(tmp, 'unset.jsonl')));

  writeFileSync(join(p, '.learn-from-mistakes.yaml'), `${readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8')}account_picker: [/bin/true]\n`);
  const blocked = lfm({}, 'agents');
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /account_picker is global-only/);
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), readFileSync(join(p, '.learn-from-mistakes.yaml'), 'utf8').replace('account_picker: [/bin/true]\n', ''));

  appendFileSync(join(p, 'defects.md'), `\n## ${new Date().toISOString().slice(0, 10)}\n\n- [tests] Umer's tests failed: UMER_FIXTURES was unset.\n- [tests] They failed again for the same reason.\n`);
  const retro = lfm({ ...pickerEnv(tmp, { PICKER_LOG: join(tmp, 'retro.jsonl') }), FAKE_ANALYSE: 'label' }, 'retro', '--foreground', '--json');
  assert.equal(retro.status, 0, retro.stderr);
  const id = JSON.parse(retro.stdout).run.id;
  const ids = query('SELECT account_id FROM invocations WHERE run_id = ? AND exit_status = ?', id, 'ok').map((r) => r.account_id);
  assert.ok(ids.length > 0 && ids.every((a) => a === 'pa_umer_b'), JSON.stringify(ids));
});
