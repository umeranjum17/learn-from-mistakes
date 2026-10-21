import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
// The CLI loads first: src/config.mjs and src/init.mjs import each other, so a test that starts at src/check.mjs crashes.
import '../bin/learn-from-mistakes-axi.mjs';
import { counts, plain } from '../src/check.mjs';
import { openStore } from '../src/store.mjs';

test('a sentence of 21 words is rejected and a sentence of 20 words passes', () => {
  const sentence = (n) => `${Array.from({ length: n }, (_, i) => `w${i}`).join(' ')}.`;
  assert.equal(plain(sentence(20), 'change', {}), '');
  assert.equal(plain(sentence(21), 'change', {}), 'change: sentence 1 has more than 20 words');
});

test('the sentence cap counts a sentence that starts lowercase, and e.g. does not end one', () => {
  assert.equal(plain('Retry failed. then it ran. then it passed.', 'change', { sentences: 3 }), '');
  assert.equal(plain('Retry failed. then it ran. then it passed. then it stopped.', 'change', { sentences: 3 }), 'change has more than 3 sentences');
  assert.equal(plain('Retry failed, e.g. the cache. Then it stopped.', 'change', { sentences: 2 }), '');
  assert.equal(plain('Retry failed, i.e. the cache. Then it stopped.', 'change', { sentences: 2 }), '');
});

test('a non-plain word names its replacement, and passive voice names its span', () => {
  assert.equal(plain('We will utilize the cache.', 'change', {}), 'change: sentence 1 uses "utilize"; use "use" instead');
  assert.equal(plain('We met prior to the launch.', 'change', {}), 'change: sentence 1 uses "prior to"; use "before" instead');
  assert.equal(plain('The lock was held by us.', 'change', {}), 'change: sentence 1 is passive ("was held"); rewrite it in the active voice');
  assert.equal(plain('Give each worker its own cache directory.', 'change', {}), '');
  assert.equal(plain('The worker was tired.', 'change', {}), '');
});

test('one captain complaint repeats its cause, and one ordinary record does not', async () => {
  const state = mkdtempSync(join(tmpdir(), 'lfm-check-'));
  after(() => rmSync(state, { recursive: true }));
  const db = await openStore(state, true);
  const now = Date.now(), iso = (days) => new Date(now - days * 86_400_000).toISOString();
  db.prepare('INSERT INTO runs (id, status, created_at, updated_at) VALUES (1, ?, ?, ?)').run('running', iso(0), iso(0));
  const record = db.prepare('INSERT INTO records (run_id, source, ts, ref, text, record_id, data) VALUES (1, ?, ?, ?, ?, ?, ?)');
  record.run('fm', iso(1), 'data/chat.tsv:4', 'why is the panel broken', 'fm:chat:4', JSON.stringify({ kind: 'complaint' }));
  record.run('fm', iso(1), 'state/a.status', 'panel broke', 'fm:a:1', JSON.stringify({ kind: 'block' }));
  record.run('fm', iso(1), 'state/b.status', 'cache broke', 'fm:b:1', JSON.stringify({ kind: 'block' }));
  const label = db.prepare("INSERT INTO labels (run_id, record_id, event, cause, why) VALUES (1, ?, 1, ?, 'why')");
  label.run('fm:chat:4', 'panel-layout');
  label.run('fm:a:1', 'cache-stale');
  const cfg = { causes: { 'panel-layout': { description: 'd' }, 'cache-stale': { description: 'd' } }, repeat: { min_incidents: 3, min_days: 2 } };
  const { causes } = counts(cfg, db, 1, { current_start: iso(7) });
  db.close();
  assert.deepEqual(causes.get('panel-layout'), { count: 1, days: 1, repeated: true }); // the captain wrote it once
  assert.deepEqual(causes.get('cache-stale'), { count: 1, days: 1, repeated: false }); // an ordinary record still needs the repeat rule
});
