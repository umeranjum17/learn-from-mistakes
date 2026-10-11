// End-to-end: runs the real CLI on copies of the synthetic examples in a throwaway LFM_HOME.
// The only machine shape is the privacy-bounded lfm-report.v1 (identifiers and counts, never prose).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = new URL('../bin/lfm.mjs', import.meta.url).pathname;
const CANARY = 'CANARY-private-prose-9f3a7c';
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-'));
  after(() => rmSync(tmp, { recursive: true }));
  cpSync(new URL('../examples', import.meta.url).pathname, join(tmp, 'p'), { recursive: true });
  const env = { ...process.env, LFM_HOME: join(tmp, 'home') };
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', join(tmp, 'p')], { encoding: 'utf8', env });
  const raw = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env });
  return { p: join(tmp, 'p'), lfm, raw };
}
const inputs = (p) => [join(p, 'labels.jsonl'), join(p, 'proposals.jsonl')];
const report = (lfm, p, ...extra) => lfm('report', '--labels', inputs(p)[0], '--proposals', inputs(p)[1], ...extra);

test('help and version work without a project file', () => {
  const { raw } = setup();
  const h = raw('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /usage: lfm/);
  assert.match(h.stdout, /ingest.*count.*report/s);
  assert.match(h.stdout, /next: lfm\b/);
  const v = raw('--version');
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.equal(raw('frobnicate').status, 2); // an unknown command is still a usage error
});

test('bare report is valid TOON and JSON lfm-report.v1 with the same projection', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const bare = report(lfm, p);
  assert.equal(bare.status, 0, bare.stderr);
  const toon = decode(bare.stdout); // invalid TOON throws
  assert.equal(toon.schema, 'lfm-report.v1');
  assert.match(bare.stderr, /next: lfm report --full/); // the next move is always offered

  const json = report(lfm, p, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(toon, JSON.parse(json.stdout)); // one allow-listed projection

  const causes = Object.fromEntries(toon.causes.map((c) => [c.cause, c]));
  assert.equal(causes['server-memory-kill'].log.incidents, 4); // occurrences: 2 collapsed into one incident
  assert.equal(causes['server-memory-kill'].log.records, 3);
  assert.equal(causes['shared-cache-lock'].log.incidents, 3); // duplicate_of collapsed
  assert.equal(causes['shared-cache-lock'].log.records, 4);
  assert.equal(causes['agent-exit-wait'].store.rows, 4); // typed store rows matched, never added to log
  assert.equal(causes['other'].repeated, false);
  assert.deepEqual(toon.coverage, { labelled: 13, total_records: 13, unlabelled: 0 });
});

test('--full adds only allow-listed ids, never record text', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const full = JSON.parse(report(lfm, p, '--full', '--json').stdout);
  const cause = full.causes.find((c) => c.cause === 'shared-cache-lock');
  assert.ok(cause.record_ids.includes('1b35bb2034fa')); // a duplicate id is still an id
  assert.equal(cause.store_row_ids.length, 0);
  const gate = full.causes.find((c) => c.cause === 'agent-exit-wait');
  assert.ok(gate.store_row_ids.includes('gate:step-1'));
  const text = JSON.stringify(full);
  assert.doesNotMatch(text, /memory killer stopped/i); // no record text
  assert.doesNotMatch(text, /Give each worker its own cache/); // no proposal change text
  assert.doesNotMatch(text, /"why"|"change"|"description"|"branch"/); // no private prose fields at all
});

test('private canary prose never reaches default, --json, --full or stderr', () => {
  const { p, lfm } = setup();
  appendFileSync(join(p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  const labels = readFileSync(join(p, 'labels.jsonl'), 'utf8').replace('Memory killer stopped', `${CANARY} Memory killer stopped`);
  writeFileSync(join(p, 'canary-labels.jsonl'), labels);
  const proposals = readFileSync(join(p, 'proposals.jsonl'), 'utf8').replace('Run builds in their own memory group', `${CANARY} Run builds in their own memory group`);
  writeFileSync(join(p, 'canary-proposals.jsonl'), proposals);
  assert.equal(lfm('ingest').status, 0);
  for (const extra of [[], ['--json'], ['--full'], ['--full', '--json']]) {
    const r = lfm('report', '--labels', join(p, 'canary-labels.jsonl'), '--proposals', join(p, 'canary-proposals.jsonl'), ...extra);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, new RegExp(CANARY));
    assert.doesNotMatch(r.stderr, new RegExp(CANARY));
  }
});

test('bad input is counted, never echoed; unresolved refs exit 1', () => {
  const { p, lfm } = setup();
  const long = `- [runner] ${'x'.repeat(20000)}\n`;
  appendFileSync(join(p, 'defects.md'), long + long); // largest existing fixture, two records
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'bad.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":"server-memory-kill","why":"x"}\n{not json\n');
  const bad = lfm('count', '--labels', join(p, 'bad.jsonl'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad\.jsonl:2: not valid JSON/);
  writeFileSync(join(p, 'refs.jsonl'), '{"cause":"server-memory-kill","target":"t","owner":"o","change":"c","refs":["nope"]}\n');
  const r = report(lfm, p, '--proposals', join(p, 'refs.jsonl'));
  assert.equal(r.status, 1);
  const model = decode(r.stdout);
  assert.equal(model.problems, 1); // a problem is counted, its text is not printed
  assert.doesNotMatch(r.stdout, /nope/);
  writeFileSync(join(p, 'odd.jsonl'), '{"id":"ffffffffffff","event":true,"cause":"server-memory-kill","why":"x"}\n');
  assert.equal(decode(lfm('count', '--labels', join(p, 'odd.jsonl')).stdout).problems, 1);
  appendFileSync(join(p, '.learn-from-mistakes.yaml'), 'colour: blue\n');
  assert.equal(lfm('count').status, 2);
  assert.match(lfm('count').stderr, /unknown key colour/);
});

test('empty input exits 3 with a next command', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, 'defects.md'), '');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  assert.match(lfm('ingest').stdout, /log +markdown-log +0 items/);
  const r = lfm('count');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /nothing to count/);
  assert.match(r.stderr, /next: lfm ingest/);
});
