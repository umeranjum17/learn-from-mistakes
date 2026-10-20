// The bundle's unlabelled section lists the records with no row in the labels table, whatever their cause: the
// same meaning report coverage counts. A real store, and the bundle step's own function, write and read the file.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
// The CLI loads first: src/config.mjs and src/init.mjs import each other, so a test that starts at src/bundle.mjs crashes.
import { InputError } from '../bin/learn-from-mistakes-axi.mjs';
import { bundle } from '../src/bundle.mjs';
import { saltedId } from '../src/sources/markdown-log.mjs';
import { openStore } from '../src/store.mjs';

test('the unlabelled section lists a record with a cause and no label, and not a record with a label and no cause', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lfm-bundle-'));
  after(() => rmSync(state, { recursive: true }));
  const db = await openStore(state, true);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO runs (id, status, created_at, updated_at) VALUES (1, ?, ?, ?)').run('running', now, now);
  const record = db.prepare('INSERT INTO records (run_id, source, ts, ref, cause, text, record_id) VALUES (1, ?, ?, ?, ?, ?, ?)');
  record.run('log', now, 'defects.md:3', 'missing-file', 'The agent cannot find the fixture.', 'log:cause-only');
  record.run('log', now, 'defects.md:5', null, 'The deploy was labelled.', 'log:label-only');
  db.prepare('INSERT INTO labels (run_id, record_id, event, cause, why) VALUES (1, ?, 1, NULL, ?)').run('log:label-only', 'The record names a defect.');

  const file = join(state, 'bundle.md');
  const window = { current_start: new Date(Date.now() - 7 * 86_400_000).toISOString(), previous_start: new Date(Date.now() - 14 * 86_400_000).toISOString() };
  bundle({ excerpts: 'off', caps: { bundle_chars: 100_000 } }, db, 1, file, window);
  db.close();

  const text = readFileSync(file, 'utf8');
  const section = text.slice(text.indexOf('## Unlabelled defect records'));
  assert.match(section, /^- \[log:cause-only\] log at defects\.md:3, \d{4}-\d{2}-\d{2}$/m);
  assert.doesNotMatch(section, /log:label-only/);
});

test('a done-done record keeps no app name in bundle.md: its id is salted and the home path is replaced', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lfm-bundle-'));
  after(() => rmSync(state, { recursive: true }));
  const db = await openStore(state, true);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO runs (id, status, created_at, updated_at) VALUES (1, ?, ?, ?)').run('running', now, now);
  const { salt } = db.prepare('SELECT salt FROM secret').get();
  const record = db.prepare('INSERT INTO records (run_id, source, ts, ref, cause, text, record_id) VALUES (1, ?, ?, ?, ?, ?, ?)');
  record.run('dd', now, '/work/notes/runs/notes/r1/run.json', null, 'verify fail: check: wrong screen', `dd:${saltedId(salt, 'notes/r1/check')}`);
  const file = join(state, 'bundle.md');
  const window = { current_start: new Date(Date.now() - 7 * 86_400_000).toISOString(), previous_start: new Date(Date.now() - 14 * 86_400_000).toISOString() };
  bundle({ excerpts: 'off', caps: { bundle_chars: 100_000 }, sources: { dd: { type: 'done-done', path: '/work/notes', apps: ['notes'] } } }, db, 1, file, window);
  db.close();

  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /notes/);
  assert.match(text, new RegExp(`^- \\[dd:${saltedId(salt, 'notes/r1/check')}\\] dd at <done-done home>/runs/${saltedId(salt, 'notes')}/r1/run\\.json, `, 'm'));
});

test('a run that stored a pre-salt done-done id refuses its bundle, even after the source leaves the config', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lfm-bundle-'));
  after(() => rmSync(state, { recursive: true }));
  const db = await openStore(state, true);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO runs (id, status, created_at, updated_at) VALUES (1, ?, ?, ?)').run('running', now, now);
  db.prepare('INSERT INTO records (run_id, source, ts, ref, cause, text, record_id) VALUES (1, ?, ?, ?, ?, ?, ?)')
    .run('dd', now, '/work/notes/runs/notes/r1/run.json', null, 'verify fail: check: wrong screen', 'dd:notes/r1/check');
  const file = join(state, 'bundle.md');
  const window = { current_start: new Date(Date.now() - 7 * 86_400_000).toISOString(), previous_start: new Date(Date.now() - 14 * 86_400_000).toISOString() };
  assert.throws(() => bundle({ excerpts: 'off', caps: { bundle_chars: 100_000 }, sources: {} }, db, 1, file, window), (e) => e instanceof InputError
    && /collected before done-done record ids were salted/.test(e.message) && /retro/.test(e.next));
  db.close();
  assert.equal(existsSync(file), false);
});

test('a firstmate inbox message whose id holds a slash is not a pre-salt done-done record', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lfm-bundle-'));
  after(() => rmSync(state, { recursive: true }));
  const db = await openStore(state, true);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO runs (id, status, created_at, updated_at) VALUES (1, ?, ?, ?)').run('running', now, now);
  db.prepare('INSERT INTO records (run_id, source, ts, ref, cause, text, record_id) VALUES (1, ?, ?, ?, ?, ?, ?)')
    .run('fm', now, '/home/fm/state/alpha.inbox/handled/1.msg', null, 'steer text', 'fm:alpha.inbox/handled/1.msg');
  const file = join(state, 'bundle.md');
  const window = { current_start: new Date(Date.now() - 7 * 86_400_000).toISOString(), previous_start: new Date(Date.now() - 14 * 86_400_000).toISOString() };
  bundle({ excerpts: 'off', caps: { bundle_chars: 100_000 }, sources: {} }, db, 1, file, window);
  db.close();
  assert.match(readFileSync(file, 'utf8'), /^- \[fm:alpha\.inbox\/handled\/1\.msg\] fm at /m);
});

test('a full bundle names the records it left out, newest first', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lfm-bundle-'));
  after(() => rmSync(state, { recursive: true }));
  const db = await openStore(state, true);
  const now = Date.now(), iso = (days) => new Date(now - days * 86_400_000).toISOString();
  db.prepare('INSERT INTO runs (id, status, created_at, updated_at) VALUES (1, ?, ?, ?)').run('running', iso(0), iso(0));
  const record = db.prepare('INSERT INTO records (run_id, source, ts, ref, text, record_id) VALUES (1, ?, ?, ?, ?, ?)');
  for (const [days, name] of [[1, 'newest'], [2, 'middle'], [3, 'oldest']]) record.run('log', iso(days), `defects.md:${days}`, 'x', `log:${name}`);
  const file = join(state, 'bundle.md');
  const window = { current_start: iso(7), previous_start: iso(14) };
  bundle({ excerpts: 'off', caps: { bundle_chars: 750 } }, db, 1, file, window); // room for the headings, the first record and the reserved lines only
  db.close();

  const text = readFileSync(file, 'utf8');
  assert.match(text, /^- \[log:newest\]/m);
  assert.match(text, /^Left out, newest first: log:middle, log:oldest\.$/m);
});
