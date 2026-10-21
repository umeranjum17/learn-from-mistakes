// The frozen quality test: five made-up mistakes, in fixed words, run through the real retro with and without
// Firstmate sources and scored as found, listed or missing. The command runs the whole retro with a recorded worker
// and judge, so this test needs no model, no key and no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(repo, 'test', 'fixtures', 'frozen-five');
const set = JSON.parse(readFileSync(join(fixtures, 'set.json'), 'utf8'));
const baseline = JSON.parse(readFileSync(join(fixtures, 'baseline.json'), 'utf8'));

// The command: the standing as one JSON document. Each variant runs once: the command runs the whole retro twice.
const cache = {};
const standing = (args = []) => {
  const key = args.join(' ') || 'default';
  if (!cache[key]) {
    const run = spawnSync(process.execPath, [join(repo, 'scripts', 'frozen-five.mjs'), '--json', ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, `the frozen five command failed: ${run.stderr}`);
    cache[key] = JSON.parse(run.stdout);
  }
  return cache[key];
};

test('the frozen set scores its five cases in both environments', () => {
  const out = standing();
  assert.deepEqual(out.cases.map((c) => c.id), set.cases.map((c) => c.id));
  assert.deepEqual(out.cases.map((c) => c.kind), ['repeated cause', 'single complaint', 'one-time defect', 'one-time defect', 'one-time defect']);
  for (const env of ['plain', 'firstmate']) {
    const verdicts = out.environments[env].verdicts;
    assert.deepEqual(Object.keys(verdicts), set.cases.map((c) => c.id), `${env} does not score the same five cases`);
    for (const [id, verdict] of Object.entries(verdicts)) assert.ok(['found', 'listed', 'missing'].includes(verdict), `${env}/${id} has the verdict ${verdict}`);
  }
});

test('the complaint repeats its cause with Firstmate sources and does not without them', () => {
  const out = standing();
  const repeats = (env, cause) => out.environments[env].repeated.some((l) => l.startsWith(`${cause}:`));
  assert.ok(repeats('firstmate', 'unchosen-key'), 'the captain complaint does not repeat its cause with Firstmate sources');
  assert.ok(!repeats('plain', 'unchosen-key'), 'an ordinary record repeats its cause without Firstmate sources');
  assert.ok(repeats('plain', 'rollout-gap') && repeats('firstmate', 'rollout-gap'), 'the repeated cause does not repeat in both environments');
});

test('a mistake counts as found only when a finding names it in plain words', () => {
  const out = standing();
  // The recorded answer gives a finding for one case only: the one whose name the finding holds.
  const named = set.cases.filter((c) => c.finding).map((c) => c.id);
  for (const env of ['plain', 'firstmate']) {
    const found = Object.entries(out.environments[env].verdicts).filter(([, v]) => v === 'found').map(([id]) => id);
    assert.deepEqual(found, named, `${env} found the wrong cases`);
  }
});

test('an unrelated finding is not counted as a hit', () => {
  const withIt = standing();
  const without = standing(['--no-unrelated']);
  // The run keeps the finding about the bystander record, and it names none of the five cases.
  const unrelated = withIt.environments.plain.findings.filter((f) => f.cause === 'other');
  assert.equal(unrelated.length, 1, 'the run did not keep the unrelated finding');
  assert.ok(!set.cases.some((c) => c.names.some((n) => unrelated[0].summary.includes(n))), 'the unrelated finding names a case');
  // Leaving it out changes no verdict: it counts for none of the five.
  for (const env of ['plain', 'firstmate']) assert.deepEqual(without.environments[env].verdicts, withIt.environments[env].verdicts, `${env} counted the unrelated finding`);
});

test('the standing matches the baseline: the found cases stay the same and a listed case stays listed', () => {
  const out = standing();
  for (const env of ['plain', 'firstmate']) {
    const verdicts = out.environments[env].verdicts, was = baseline.environments[env];
    const found = Object.entries(verdicts).filter(([, v]) => v === 'found').map(([id]) => id);
    const foundBefore = Object.entries(was).filter(([, v]) => v === 'found').map(([id]) => id);
    assert.deepEqual(found, foundBefore, `${env} found other cases than the baseline`);
    for (const [id, verdict] of Object.entries(was)) if (verdict === 'listed') assert.notEqual(verdicts[id], 'missing', `${env}/${id} fell back to missing`);
  }
});
