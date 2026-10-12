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
  for (const flag of ['--dir', '--labels', '--proposals']) assert.match(bare.stderr, new RegExp(flag)); // the hint names the inputs it used
  assert.ok(!bare.stderr.includes(p), 'the hint must not echo an input path value');

  const json = report(lfm, p, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(toon, JSON.parse(json.stdout)); // one allow-listed projection

  const fullJson = report(lfm, p, '--full', '--json');
  assert.equal(fullJson.status, 0, fullJson.stderr);
  assert.doesNotMatch(fullJson.stderr, /next: lfm report --json/); // never suggest a flag the run already used
  assert.equal(JSON.parse(fullJson.stdout).schema, 'lfm-report.v1'); // the projection is unchanged

  const causes = Object.fromEntries(toon.causes.map((c) => [c.cause, c]));
  assert.equal(causes['server-memory-kill'].log.incidents, 4); // occurrences: 2 collapsed into one incident
  assert.equal(causes['server-memory-kill'].log.records, 3);
  assert.equal(causes['shared-cache-lock'].log.incidents, 3); // duplicate_of collapsed
  assert.equal(causes['shared-cache-lock'].log.records, 4);
  assert.equal(causes['agent-exit-wait'].store.rows, 4); // typed store rows matched, never added to log
  assert.equal(causes['other'].repeated, false);
  assert.deepEqual(toon.coverage, { labelled: 13, total_records: 13, unlabelled: 0 });
});

test('next hints compose the flags already used so both report chains terminate at full+json', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const nextOf = (stderr) => stderr.split('\n').find((l) => l.startsWith('next: '))?.slice(6).split('   #')[0].trim();
  const runHint = (line) => lfm(...line.replace(/^lfm /, '').split(' '), '--labels', inputs(p)[0], '--proposals', inputs(p)[1]);
  const assertTerminal = (r) => {
    assert.equal(r.status, 0, r.stderr);
    const model = JSON.parse(r.stdout);
    assert.equal(model.schema, 'lfm-report.v1');
    assert.ok(model.causes.find((c) => c.cause === 'shared-cache-lock').record_ids.includes('1b35bb2034fa')); // detail ids survive the chain
    assert.doesNotMatch(r.stdout, /"why"|"change"|"description"|"branch"/); // no private prose field
    assert.ok(!r.stderr.includes(p), 'the hint must not echo an input path value');
    assert.equal(nextOf(r.stderr), undefined); // the chain ends here
  };

  const hint1 = nextOf(report(lfm, p).stderr); // report -> --full
  assert.equal(hint1, 'lfm report --full');
  const hint2 = nextOf(runHint(hint1).stderr); // --full -> --full --json
  assert.equal(hint2, 'lfm report --full --json');
  assertTerminal(runHint(hint2)); // --full --json is terminal

  const hintJson = nextOf(report(lfm, p, '--json').stderr); // report --json -> --full --json
  assert.equal(hintJson, 'lfm report --full --json');
  assertTerminal(runHint(hintJson));
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
  const canaryLabels = join(p, `${CANARY}-labels.jsonl`);
  writeFileSync(canaryLabels, labels);
  const proposals = readFileSync(join(p, 'proposals.jsonl'), 'utf8').replace('Run builds in their own memory group', `${CANARY} Run builds in their own memory group`);
  const canaryProposals = join(p, `${CANARY}-proposals.jsonl`);
  writeFileSync(canaryProposals, proposals);
  assert.equal(lfm('ingest').status, 0);
  for (const extra of [[], ['--json'], ['--full'], ['--full', '--json']]) {
    const r = lfm('report', '--labels', canaryLabels, '--proposals', canaryProposals, ...extra);
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
  const full = JSON.parse(report(lfm, p, '--proposals', join(p, 'refs.jsonl'), '--full', '--json').stdout);
  assert.deepEqual(full.causes.find((c) => c.cause === 'server-memory-kill').proposal_refs, []); // an unresolved ref is never echoed as evidence
  writeFileSync(join(p, 'odd.jsonl'), '{"id":"ffffffffffff","event":true,"cause":"server-memory-kill","why":"x"}\n');
  assert.equal(decode(lfm('count', '--labels', join(p, 'odd.jsonl')).stdout).problems, 1);
  appendFileSync(join(p, '.learn-from-mistakes.yaml'), 'colour: blue\n');
  assert.equal(lfm('count').status, 2);
  assert.match(lfm('count').stderr, /unknown key colour/);
});

test('prototype-named causes are counted as problems, never crash or vanish', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'proto.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":"constructor","why":"x"}\n');
  writeFileSync(join(p, 'proto-proposals.jsonl'), '{"cause":"constructor","target":"t","owner":"o","change":"c","refs":["2034b8c4ce57"]}\n');
  const r = lfm('report', '--labels', join(p, 'proto.jsonl'), '--proposals', join(p, 'proto-proposals.jsonl'));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /next: lfm report .*--labels .*--proposals/); // the re-run keeps the inputs it was given
  const model = decode(r.stdout);
  assert.equal(model.problems, 2); // the label and the proposal are each counted
  assert.ok(!model.causes.some((c) => c.cause === 'constructor'));
});

test('non-string causes are counted as problems, never coerced into a configured cause', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'array-labels.jsonl'), '{"id":"2034b8c4ce57","event":true,"cause":["server-memory-kill"],"why":"x"}\n');
  writeFileSync(join(p, 'array-proposals.jsonl'), '{"cause":["server-memory-kill"],"target":"t","owner":"o","change":"c","refs":["2034b8c4ce57"]}\n');
  const r = lfm('report', '--labels', join(p, 'array-labels.jsonl'), '--proposals', join(p, 'array-proposals.jsonl'));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(decode(r.stdout).problems, 2); // the label and the proposal are each counted
  assert.ok(!decode(r.stdout).causes.some((c) => c.cause === 'server-memory-kill')); // and the cause is not silently grouped
});

test('an unreadable source or input file is a usage error, never a crash', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: missing.md }\n');
  const missing = lfm('ingest');
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /missing\.md: cannot read \(ENOENT\)/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /); // no stack trace
  cpSync(join(new URL('../examples', import.meta.url).pathname, '.learn-from-mistakes.yaml'), join(p, '.learn-from-mistakes.yaml'));
  assert.equal(lfm('ingest').status, 0);
  const dir = lfm('count', '--labels', p);
  assert.equal(dir.status, 2, dir.stderr);
  assert.match(dir.stderr, /cannot read \(EISDIR\)/);
  assert.doesNotMatch(dir.stderr, /\n\s+at /);
});

test('empty input exits 3 with a next command', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, 'defects.md'), '');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  const ing = lfm('ingest');
  assert.match(ing.stdout, /log +markdown-log +0 items/);
  assert.match(ing.stdout, /then lfm count .*--dir/); // the labelling step keeps the dir it was told to use
  assert.match(ing.stderr, /next: lfm\b.*--dir/); // the report hint keeps the dir it was told to use
  const r = lfm('count');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /nothing to count/);
  assert.match(r.stderr, /next: lfm ingest/);
  assert.match(r.stderr, /--dir/);
  assert.ok(!r.stderr.includes(p), 'the empty-input hint must not echo an input path value');
});
