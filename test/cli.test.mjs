// End-to-end: runs the real CLI on copies of the synthetic examples in a throwaway LFM_HOME.
// The report is the privacy-bounded lfm-report.v1 (identifiers and counts, never prose); lfm-changes.v1
// carries only the owner-written what/why of each applied change.
// LFM_CLI points the same journeys at an installed bin (the verify skill's --package proof).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { decode } from '@toon-format/toon';

const CLI = process.env.LFM_CLI || new URL('../bin/lfm.mjs', import.meta.url).pathname;
const CANARY = 'CANARY-private-prose-9f3a7c';
function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-'));
  after(() => rmSync(tmp, { recursive: true }));
  cpSync(new URL('../examples', import.meta.url).pathname, join(tmp, 'p'), { recursive: true });
  const env = { ...process.env, LFM_HOME: join(tmp, 'home') };
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', join(tmp, 'p')], { encoding: 'utf8', env });
  const raw = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp, env });
  return { p: join(tmp, 'p'), home: join(tmp, 'home'), lfm, raw };
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

test('every rejected input names what was wrong and a next step, never the whole usage', () => {
  const { p, lfm, raw } = setup();
  assert.equal(lfm('ingest').status, 0);
  writeFileSync(join(p, 'bad.jsonl'), '{"id":"x"}\n{not json\n');
  const HELP = /^next: lfm --help   # supported commands and options$/m;
  const CHANGE = /^next: lfm change applied --cause <cause> --ref <ref> \[--at <time>\]/m;
  const known = '(known: server-memory-kill, shared-cache-lock, agent-exit-wait; "other" is reserved)';
  const applied = (...args) => lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'abc1234', ...args);
  for (const [run, code, error, next] of [
    [() => raw('frobnicate'), 2, 'unknown command "frobnicate" (commands: ingest, count, report, change applied, changes)', HELP],
    [() => raw('--bogus'), 2, 'unknown option "--bogus"', HELP], // a bare unknown flag points at --help
    [() => raw('report', '--bogus'), 2, 'unknown option "--bogus"', /^next: lfm report \[--dir <dir>\]/m],
    [() => raw('change'), 2, '"change" must be followed by "applied"', CHANGE],
    [() => raw('report', 'extra'), 2, 'unexpected argument "extra"', /^next: lfm report \[/m],
    [() => raw('report', '--dir'), 2, '--dir needs a value', /^next: lfm report \[/m],
    [() => raw('changes', '--full'), 2, 'changes does not take --full', /^next: lfm changes \[--dir <dir>\] \[--json\]$/m], // before any config is read
    [() => raw('ingest', '--json'), 2, 'ingest does not take --json', /^next: lfm ingest \[--dir <dir>\]$/m],
    [() => raw('ingest', '--labels', 'x'), 2, 'ingest does not take --labels', /^next: lfm ingest /m],
    [() => raw('report', '--cause', 'x'), 2, 'report does not take --cause', /^next: lfm report \[/m],
    [() => raw('--cause', 'x'), 2, 'report does not take --cause', HELP], // bare: no command was typed, so --help
    [() => raw('report', '--dir', 'a\u001b[31m'), 2, '--dir (invalid value): a path must not contain control characters', /^next: lfm report \[/m],
    [() => raw(), 2, /^error: no \.learn-from-mistakes\.yaml in .*\n(.*\n)*  log: \{ type: markdown-log, path: defects\.md \}/m, HELP], // a config to copy
    [() => lfm('change', 'applied', '--cause', 'nope', '--ref', 'abc1234'), 2, `unknown cause "nope" ${known}`, CHANGE],
    [() => lfm('change', 'applied', '--cause', 'other', '--ref', 'abc1234'), 2, /^error: cause "other" is reserved and never recordable \(known: server-memory-kill,/m, CHANGE],
    [() => lfm('change', 'applied', '--cause', 'y'.repeat(81), '--ref', 'abc1234'), 2, `unknown cause (invalid value) ${known}`, CHANGE], // never echoes a long value
    [() => lfm('change', 'applied', '--cause', 'a\u001b[31m', '--ref', 'abc1234'), 2, `unknown cause (invalid value) ${known}`, CHANGE], // nor a control character
    [() => lfm('change', 'applied', '--cause', 'server-memory-kill'), 2, 'change applied needs --ref', CHANGE],
    [() => lfm('change', 'applied', '--cause', 'server-memory-kill', '--ref', 'XYZ'), 2, '--ref "XYZ" must be a 7-40 lowercase hex commit or sha256:<64 lowercase hex>', /^next: git rev-parse HEAD/m],
    [() => applied('--at', 'not-a-time'), 2, '--at "not-a-time" must be an ISO 8601 time', /^next: lfm change applied --cause server-memory-kill --ref abc1234 --at 2026-10-12T09:00:00Z/m],
    [() => applied('--full'), 2, 'change applied does not take --full', CHANGE],
    [() => applied('--why', '   '), 2, '--why "   " must be one line of 1-200 characters, with no line breaks or control characters', CHANGE],
    [() => applied('--what', 'x'.repeat(201)), 2, '--what (invalid value) must be one line of 1-200 characters, with no line breaks or control characters', CHANGE],
    [() => applied('--what', ''), 2, '--what "" must be one line of 1-200 characters, with no line breaks or control characters', CHANGE],
    [() => lfm('count', '--labels', join(p, 'bad.jsonl')), 1, /^error: .*bad\.jsonl:2: not valid JSON$/m, /^next: lfm count   # run again after fixing \(keep your --dir --labels\)$/m], // input problem, not usage
  ]) {
    const r = run();
    const what = typeof error === 'string' ? error : String(error);
    assert.equal(r.status, code, `${what}\n${r.stderr}`);
    assert.equal(r.stdout, '', what);
    if (typeof error === 'string') assert.ok(r.stderr.split('\n').includes(`error: ${error}`), `${what}\n${r.stderr}`);
    else assert.match(r.stderr, error);
    assert.match(r.stderr, next, what);
    assert.doesNotMatch(r.stderr, /usage: lfm|--proposals <file> +proposals\.jsonl to read/, `${what}: printed the usage block`);
    assert.doesNotMatch(r.stderr, /y{81}|\u001b/, `${what}: echoed a long or control value`);
  }
});

test('bare report is valid TOON and JSON lfm-report.v1 with the same projection', () => {
  const { p, lfm } = setup();
  const ing = lfm('ingest');
  assert.equal(ing.status, 0);
  assert.doesNotMatch(ing.stderr, /no causes configured/); // the example config names its causes
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

test('ingest identifies the store by the rows it read, not its mtime, and never writes the store', () => {
  const { p, home, lfm } = setup();
  const db = join(p, 'gate.sqlite');
  const bytes = () => createHash('sha256').update(readFileSync(db)).digest('hex');
  const ingest = () => {
    const before = bytes();
    const r = lfm('ingest');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bytes(), before); // the read leaves the store's bytes as they were
    const short = r.stdout.match(/^gate +no-mistakes +5 items  sha256 ([0-9a-f]{12})$/m)?.[1];
    assert.ok(short, r.stdout);
    const hash = JSON.parse(readFileSync(join(home, 'state', 'example', 'sources.json'), 'utf8')).sources.find((s) => s.id === 'gate').hash;
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash.slice(0, 12), short);
    return hash;
  };
  const first = ingest();
  utimesSync(db, new Date('2001-02-03T04:05:06Z'), new Date('2001-02-03T04:05:06Z')); // same rows, new mtime
  assert.equal(ingest(), first);

  const w = new DatabaseSync(db);
  w.prepare("UPDATE step_results SET error = 'not read' WHERE id = 'step-2'").run(); // a completed step: new bytes, same rows read
  assert.equal(ingest(), first);
  const { atime, mtime } = statSync(db);
  w.prepare("UPDATE step_results SET error = 'lint: 3 errors' WHERE id = 'step-5'").run(); // one failed step's text
  w.close();
  utimesSync(db, atime, mtime); // changed rows, same mtime
  assert.equal(statSync(db).mtimeMs, mtime.getTime());
  assert.notEqual(ingest(), first);
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
    assert.ok(model.causes.find((c) => c.cause === 'agent-exit-wait').store_row_ids.includes('gate:step-1')); // detail ids survive the chain
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

test('--full adds only non-content ids, never record text or record ids', () => {
  const { p, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const full = JSON.parse(report(lfm, p, '--full', '--json').stdout);
  const cause = full.causes.find((c) => c.cause === 'shared-cache-lock');
  assert.ok(!('record_ids' in cause)); // a content hash is never emitted
  assert.deepEqual(cause.proposal_refs, []); // refs that are record ids are not echoed as evidence
  assert.equal(cause.store_row_ids.length, 0);
  const gate = full.causes.find((c) => c.cause === 'agent-exit-wait');
  assert.ok(gate.store_row_ids.includes('gate:step-1'));
  assert.ok(gate.proposal_refs.includes('gate:step-1')); // a non-content ref survives
  const text = JSON.stringify(full);
  assert.doesNotMatch(text, /memory killer stopped/i); // no record text
  assert.doesNotMatch(text, /1b35bb2034fa/); // no content-derived record id
  assert.doesNotMatch(text, /Give each worker its own cache/); // no proposal change text
  assert.doesNotMatch(text, /"why"|"change"|"description"|"branch"/); // no private prose fields at all
});

test('private canary prose never reaches default, --json, --full or stderr', () => {
  const { p, lfm } = setup();
  appendFileSync(join(p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  const plant = (text, anchor) => {
    assert.ok(text.includes(anchor), `fixture has no "${anchor}" to carry the canary`);
    return text.replace(anchor, `${CANARY} ${anchor}`);
  };
  const canaryLabels = join(p, `${CANARY}-labels.jsonl`);
  writeFileSync(canaryLabels, plant(readFileSync(join(p, 'labels.jsonl'), 'utf8'), 'Memory killer stopped'));
  const canaryProposals = join(p, `${CANARY}-proposals.jsonl`);
  writeFileSync(canaryProposals, plant(readFileSync(join(p, 'proposals.jsonl'), 'utf8'), 'Run builds in their own memory group'));
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
  assert.equal(bad.status, 1); // a bad line in a file the run reads is an input problem
  assert.match(bad.stderr, /^error: .*bad\.jsonl:2: not valid JSON$/m);
  writeFileSync(join(p, 'refs.jsonl'), '{"cause":"server-memory-kill","target":"t","owner":"o","change":"c","refs":["nope"]}\n');
  const r = report(lfm, p, '--proposals', join(p, 'refs.jsonl'));
  assert.equal(r.status, 1);
  const model = decode(r.stdout);
  assert.equal(model.problems, 1); // a problem is counted in the report, its line goes to stderr only
  assert.doesNotMatch(r.stdout, /nope/);
  assert.match(r.stderr, /^problem: refs\.jsonl:1: 1 of 1 refs not found$/m);
  assert.doesNotMatch(r.stderr, /nope/); // a ref may be a record id: counted, never echoed
  const full = JSON.parse(report(lfm, p, '--proposals', join(p, 'refs.jsonl'), '--full', '--json').stdout);
  assert.deepEqual(full.causes.find((c) => c.cause === 'server-memory-kill').proposal_refs, []); // an unresolved ref is never echoed as evidence
  // A label orphaned by an edited record, and a second label for a real record: the user sees which
  // lines broke, never the real record's id (a hash of its private text).
  writeFileSync(join(p, 'odd.jsonl'), '{"id":"ffffffffffff","event":true,"cause":"server-memory-kill","why":"x"}\n'
    + '{"id":"2034b8c4ce57","event":true,"cause":"server-memory-kill","why":"x"}\n{"id":"2034b8c4ce57","event":false,"why":"x"}\n');
  const odd = lfm('count', '--labels', join(p, 'odd.jsonl'));
  assert.equal(decode(odd.stdout).problems, 2);
  assert.match(odd.stderr, /^problem: odd\.jsonl:1: unknown record id \(its record text changed or it was never ingested\)$/m);
  assert.match(odd.stderr, /^problem: odd\.jsonl:3: second label for the record labelled at line 2$/m);
  assert.doesNotMatch(odd.stderr, /2034b8c4ce57|ffffffffffff/); // no record id, current or orphaned
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
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  gate: { type: no-mistakes, path: no-state.sqlite }\n');
  const store = lfm('ingest');
  assert.equal(store.status, 2, store.stderr);
  assert.match(store.stderr, /^error: .*no-state\.sqlite: no such file$/m);
  assert.match(store.stderr, /^next: remove the gate source or point its path at your no-mistakes state\.sqlite$/m);
  assert.doesNotMatch(missing.stderr, /\n\s+at /); // no stack trace
  cpSync(join(new URL('../examples', import.meta.url).pathname, '.learn-from-mistakes.yaml'), join(p, '.learn-from-mistakes.yaml'));
  assert.equal(lfm('ingest').status, 0);
  const dir = lfm('count', '--labels', p);
  assert.equal(dir.status, 2, dir.stderr);
  assert.match(dir.stderr, /cannot read \(EISDIR\)/);
  assert.doesNotMatch(dir.stderr, /\n\s+at /);
});

test('an explicit labels or proposals path that does not exist is a usage error', () => {
  const { p, home, lfm } = setup();
  assert.equal(lfm('ingest').status, 0);
  const unlabelled = lfm('report');
  assert.equal(unlabelled.status, 0); // the default state-dir inputs may be absent before labelling
  const records = join(home, 'state', 'example', 'records.jsonl');
  assert.ok(unlabelled.stderr.split('\n').some((l) => l.startsWith(`next: label ${records} into labels.jsonl`)), unlabelled.stderr); // with zero labels, labelling the named file is the next step
  const labels = lfm('report', '--labels', join(p, 'typo-labels.jsonl'));
  assert.equal(labels.status, 2, labels.stdout);
  assert.match(labels.stderr, /^error: --labels .*typo-labels\.jsonl: no such file$/m);
  const proposals = lfm('report', '--proposals', join(p, 'typo-proposals.jsonl'));
  assert.equal(proposals.status, 2, proposals.stdout);
  assert.match(proposals.stderr, /^error: --proposals .*typo-proposals\.jsonl: no such file$/m);
});

test('change applied appends an append-only ledger the report counts and changes exports', () => {
  const { p, home, lfm } = setup();
  const ledger = join(home, 'state', 'example', 'changes.jsonl');
  const change = (...args) => lfm('change', 'applied', ...args);
  const exported = (...args) => {
    const r = lfm('changes', ...args);
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const empty = JSON.parse(exported('--json').stdout); // needs the config only: no ingest, no ledger yet
  assert.equal(empty.schema, 'lfm-changes.v1');
  assert.deepEqual(empty.changes, []);
  assert.equal(change('--cause', 'nope', '--ref', 'abc1234').status, 2); // rejected input creates nothing
  assert.ok(!existsSync(ledger));
  // Private prose sits in every input; it must never reach any change or report output.
  appendFileSync(join(p, 'defects.md'), `- [runner] ${CANARY} stopped the server -> 1 h -> OPEN.\n`);
  const plant = (text, anchor) => {
    assert.ok(text.includes(anchor), `fixture has no "${anchor}" to carry the canary`);
    return text.replace(anchor, `${CANARY} ${anchor}`);
  };
  const labels = join(p, `${CANARY}-labels.jsonl`);
  writeFileSync(labels, plant(readFileSync(join(p, 'labels.jsonl'), 'utf8'), 'Memory killer stopped'));
  const proposals = join(p, `${CANARY}-proposals.jsonl`);
  writeFileSync(proposals, plant(readFileSync(join(p, 'proposals.jsonl'), 'utf8'), 'Run builds in their own memory group'));
  assert.equal(lfm('ingest').status, 0);
  const inputs = ['--labels', labels, '--proposals', proposals];

  const first = change('--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(first.status, 0, first.stderr);
  const firstEntry = decode(first.stdout); // one TOON object on stdout
  assert.deepEqual(Object.keys(firstEntry).sort(), ['at', 'cause', 'id', 'ref', 'v']);
  assert.deepEqual({ v: firstEntry.v, id: firstEntry.id, cause: firstEntry.cause, ref: firstEntry.ref },
    { v: 1, id: 'chg-1', cause: 'server-memory-kill', ref: 'abc1234' });
  assert.ok(!Number.isNaN(Date.parse(firstEntry.at)), 'default --at is a readable time');
  assert.match(first.stderr, /next: lfm report   # the report with the ledger/);
  const afterFirst = readFileSync(ledger);
  assert.deepEqual(JSON.parse(afterFirst.toString()), firstEntry);

  const AT = '2026-01-02T03:04:05Z';
  const REF2 = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  // Owner text a report must never carry; commas, quotes and colons stress the TOON table.
  const WHAT = 'OWNER-WHAT-41c2: builds run in their own "memory group", 🙂';
  const WHY = 'OWNER-WHY-7d0e: the killer, not the build, stopped the server';
  const second = change('--cause', 'server-memory-kill', '--ref', REF2, '--at', AT, '--what', `  ${WHAT} `, '--why', WHY, '--json');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), { v: 1, id: 'chg-2', cause: 'server-memory-kill', ref: REF2, at: '2026-01-02T03:04:05.000Z' }); // the echo never carries what/why
  const afterSecond = readFileSync(ledger);
  assert.ok(afterSecond.subarray(0, afterFirst.length).equals(afterFirst)); // the second entry keeps every prior byte

  for (const args of [
    ['--cause', 'nope', '--ref', 'abc1234'], // unknown cause
    ['--cause', 'other', '--ref', 'abc1234'], // `other` is never recordable
    ['--cause', 'server-memory-kill', '--ref', 'xyz'], // bad ref
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--at', 'not-a-time'], // bad --at
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--bogus'], // unknown flag
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--full'], // --full is report-only
    ['--cause', 'server-memory-kill'], // missing --ref
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what', ''], // empty what
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--why', '   '], // blank why
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what', 'x'.repeat(201)], // 201 characters
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--why', 'line one\nline two'], // newline
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what', 'bell\u0007'], // control character
    ['--cause', 'server-memory-kill', '--ref', 'abc1234', '--what'], // missing value
  ]) {
    assert.equal(change(...args).status, 2, args.join(' '));
    assert.ok(readFileSync(ledger).equals(afterSecond), `rejected input changed the ledger: ${args.join(' ')}`);
  }
  const badWhy = change('--cause', 'server-memory-kill', '--ref', 'abc1234', '--why', `${WHY}\nsecond line`);
  assert.match(badWhy.stderr, /^error: --why \(invalid value\) must be one line of 1-200 characters/m); // the rule, never the text
  assert.doesNotMatch(badWhy.stderr, /OWNER-WHY/);
  appendFileSync(ledger, 'not json\n');
  const beforeRetry = readFileSync(ledger);
  const corrupt = change('--cause', 'server-memory-kill', '--ref', 'abc1234');
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /^error: .*changes\.jsonl:3: not valid JSON$/m);
  assert.match(corrupt.stderr, /^next: lfm changes   # check the ledger again/m);
  assert.doesNotMatch(corrupt.stderr, /not json\n/); // file:line only, never line contents
  assert.ok(readFileSync(ledger).equals(beforeRetry));
  const corruptExport = lfm('changes', '--json');
  assert.equal(corruptExport.status, 1);
  assert.equal(corruptExport.stdout, ''); // no partial export to join on
  assert.match(corruptExport.stderr, /changes\.jsonl:3: not valid JSON/);
  for (const bad of [{ id: 'chg-3', what: 'line one\nline two' }, { id: 'chg-3', why: 'x'.repeat(201) }, { id: 'chg-2' }]) {
    writeFileSync(ledger, Buffer.concat([afterSecond, Buffer.from(JSON.stringify({ v: 1, cause: 'server-memory-kill', ref: 'abc1234', at: AT, ...bad }) + '\n')]));
    const r = lfm('changes', '--json'); // a hand-edited ledger never exports bad text or a repeated join key
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, bad.id === 'chg-2' ? /changes\.jsonl:3: repeats change id "chg-2"/ : /changes\.jsonl:3: not a valid change entry/);
  }
  writeFileSync(ledger, afterSecond); // repair the scratch corruption for the report below

  for (const args of [['--full'], ['--labels', labels], ['--cause', 'server-memory-kill'], ['--what', 'x']]) {
    assert.equal(lfm('changes', ...args).status, 2, args.join(' ')); // report and change-applied flags are not export flags
  }
  const changesJson = exported('--json'); // a fresh process reads the persisted ledger
  const exportModel = JSON.parse(changesJson.stdout);
  assert.deepEqual(Object.keys(exportModel), ['schema', 'generated_at', 'project', 'changes']);
  assert.equal(exportModel.schema, 'lfm-changes.v1');
  assert.equal(exportModel.project, 'example');
  assert.ok(!Number.isNaN(Date.parse(exportModel.generated_at)));
  assert.deepEqual(exportModel.changes, [
    { id: 'chg-1', cause: 'server-memory-kill', ref: 'abc1234', at: firstEntry.at, what: '', why: '' },
    { id: 'chg-2', cause: 'server-memory-kill', ref: REF2, at: '2026-01-02T03:04:05.000Z', what: WHAT, why: WHY },
  ]);
  assert.match(changesJson.stderr, /next: lfm report /);
  const changesToon = exported();
  assert.deepEqual({ ...decode(changesToon.stdout), generated_at: exportModel.generated_at }, exportModel); // TOON decodes equal to JSON
  assert.match(changesToon.stderr, /next: lfm changes --json/);

  const json = lfm('report', ...inputs, '--json'); // a fresh process reads the persisted ledger
  assert.equal(json.status, 0, json.stderr);
  const model = JSON.parse(json.stdout);
  assert.equal(model.schema, 'lfm-report.v1');
  assert.deepEqual(model.ledger, { entries: 2 });
  assert.deepEqual(model.causes.find((c) => c.cause === 'server-memory-kill').changes, { count: 2, last_at: firstEntry.at });
  assert.deepEqual(model.causes.find((c) => c.cause === 'shared-cache-lock').changes, { count: 0, last_at: '' });
  const bare = lfm('report', ...inputs);
  assert.equal(bare.status, 0, bare.stderr);
  assert.deepEqual(decode(bare.stdout), model); // TOON decodes equal to JSON
  const fullRun = lfm('report', ...inputs, '--full', '--json');
  assert.equal(fullRun.status, 0, fullRun.stderr);
  const fullMem = JSON.parse(fullRun.stdout).causes.find((c) => c.cause === 'server-memory-kill');
  assert.deepEqual(fullMem.change_ids, ['chg-1', 'chg-2']);
  assert.deepEqual(fullMem.change_refs, ['abc1234', REF2]);
  for (const out of [first.stdout, first.stderr, second.stdout, second.stderr, json.stdout, json.stderr, bare.stdout, fullRun.stdout,
    changesJson.stdout, changesJson.stderr, changesToon.stdout, changesToon.stderr]) {
    assert.doesNotMatch(out, new RegExp(CANARY));
  }
  for (const out of [second.stdout, json.stdout, json.stderr, bare.stdout, bare.stderr, fullRun.stdout, fullRun.stderr]) {
    assert.doesNotMatch(out, /OWNER-WHAT|OWNER-WHY/); // what/why reach only `changes`, never the report
  }

  const third = change('--cause', 'shared-cache-lock', '--ref', 'def5678', '--what', 'x'.repeat(200), '--why', 'y'); // 200 is the limit
  assert.equal(third.status, 0, third.stderr);
  const later = JSON.parse(exported('--json').stdout);
  assert.deepEqual(later.changes.slice(0, 2), exportModel.changes); // ids are stable after a later append
  assert.deepEqual(later.changes[2], { id: 'chg-3', cause: 'shared-cache-lock', ref: 'def5678', at: later.changes[2].at, what: 'x'.repeat(200), why: 'y' });
});

test('empty input exits 3 with a next command', () => {
  const { p, lfm } = setup();
  writeFileSync(join(p, 'defects.md'), '');
  writeFileSync(join(p, '.learn-from-mistakes.yaml'), 'sources:\n  log: { type: markdown-log, path: defects.md }\n');
  const ing = lfm('ingest');
  assert.match(ing.stdout, /log +markdown-log +0 items/);
  assert.match(ing.stderr, /^next: no causes configured: every label will be other; ask your agent to propose causes$/m);
  assert.match(ing.stdout, /then lfm count .*--dir/); // the labelling step keeps the dir it was told to use
  assert.match(ing.stderr, /next: lfm\b.*--dir/); // the report hint keeps the dir it was told to use
  const r = lfm('count');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /nothing to count/);
  assert.match(r.stderr, /next: lfm ingest/);
  assert.match(r.stderr, /--dir/);
  assert.ok(!r.stderr.includes(p), 'the empty-input hint must not echo an input path value');
});
