// End-to-end: runs the real CLI on copies of the synthetic examples in a throwaway LFM_HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const CLI = new URL('../bin/lfm.mjs', import.meta.url).pathname;
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-'));
  after(() => rmSync(tmp, { recursive: true }));
  cpSync(new URL('../examples', import.meta.url).pathname, join(tmp, 'p'), { recursive: true });
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', join(tmp, 'p')], { encoding: 'utf8', env: { ...process.env, LFM_HOME: join(tmp, 'home') } });
  return { p: join(tmp, 'p'), lfm };
}

test('ingest, count and report on the examples', () => {
  const { p, lfm } = setup();
  const ingest = lfm('ingest');
  assert.equal(ingest.status, 0, ingest.stderr);
  assert.match(ingest.stdout, /log +markdown-log +13 items/);
  assert.match(ingest.stdout, /gate +no-mistakes +5 items/);
  const bare = lfm('count');
  assert.match(bare.stdout, /13 unlabelled and not counted/);
  assert.match(bare.stdout, /agent-exit-wait +- +4 \(3 d\) +yes \(store\)/);
  const r = lfm('report', '--labels', join(p, 'labels.jsonl'), '--proposals', join(p, 'proposals.jsonl'));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /## server-memory-kill: repeated \(log\)\n\n.*\n\n- Log \(agent-judged\): 4 incidents in 3 records/); // occurrences: 2
  assert.match(r.stdout, /shared-cache-lock: repeated \(log\)[^#]*3 incidents in 4 records/); // one duplicate collapsed
  assert.match(r.stdout, /\[same incident as defects\.md:16\]/);
  assert.match(r.stdout, /gate:step-6 2026-03-04T10:10:00\.000Z review on fix\/retry/);
  assert.doesNotMatch(r.stdout, /step-5/); // a different error does not match the rule
  assert.match(r.stdout, /## other: not repeated/);
  assert.match(r.stdout, /0 unlabelled records were not analysed/);
});

test('bad input is named, never counted', () => {
  const { p, lfm } = setup();
  const long = `- [runner] ${'x'.repeat(20000)}\n`;
  appendFileSync(join(p, 'defects.md'), long + long);
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'bad.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":"server-memory-kill","why":"x"}\n{not json\n');
  const bad = lfm('count', '--labels', join(p, 'bad.jsonl'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad\.jsonl:2: not valid JSON/);
  writeFileSync(join(p, 'refs.jsonl'), '{"cause":"server-memory-kill","target":"t","owner":"o","change":"c","refs":["nope"]}\n');
  writeFileSync(join(p, 'odd.jsonl'), '{"id":"ffffffffffff","event":true,"cause":"server-memory-kill","why":"x"}\n');
  const r = lfm('report', '--labels', join(p, 'labels.jsonl'), '--proposals', join(p, 'refs.jsonl'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /refs not found: nope/);
  assert.match(r.stdout, /\*\*evidence not checked:\*\*/);
  assert.match(r.stdout, /2 unlabelled records were not analysed/); // both long lines kept, as two records
  assert.match(lfm('count', '--labels', join(p, 'odd.jsonl')).stdout, /unknown record id ffffffffffff/);
  appendFileSync(join(p, '.learn-from-mistakes.yaml'), 'colour: blue\n');
  assert.match(lfm('count').stderr, /unknown key colour/);
});

test('empty input exits 3', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, 'defects.md'), '');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  assert.match(lfm('ingest').stdout, /log +markdown-log +0 items/);
  const r = lfm('count');
  assert.equal(r.status, 3);
  assert.match(r.stdout, /nothing to count/);
});
