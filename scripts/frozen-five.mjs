#!/usr/bin/env node
// The frozen quality test: the same five made-up mistakes, in fixed words, run through the real retro with and
// without Firstmate sources, and scored. The worker's and the judge's answers are recorded
// (test/fixtures/frozen-five/set.json), so the run needs no model, no key and no network: it is CI-safe.
//
// The scoring, per case:
//   found   a kept finding names the case in plain words (the finding's summary, why chain or cost holds the name).
//   listed  the Not checked section of report.txt carries the case's words: the start of the record's own text (the
//           report cuts the text short) or the worker's stored explanation of it. A pointer alone (a file and a
//           line) is not a listing: the reader cannot tell which mistake it names.
//   missing neither holds: the mistake left no readable name and no listing.
//
// The dates of the records count back from the day the test runs, so the records stay inside the retro window and the
// standing does not move with the calendar.
//
// Usage: node scripts/frozen-five.mjs [--json] [--check] [--update] [--no-unrelated] [--keep]
//   --json          print the standing as one JSON document (the test reads it).
//   --check         exit 1 when the standing moved away from test/fixtures/frozen-five/baseline.json.
//   --update        write the standing to that file.
//   --no-unrelated  leave the finding about the bystander record out, so a test can show it counts for no case.
//   --keep          keep the scratch dir and print its path.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';

const repo = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(repo, 'test', 'fixtures', 'frozen-five');
const set = JSON.parse(readFileSync(join(fixtures, 'set.json'), 'utf8'));
const baselineFile = join(fixtures, 'baseline.json');
const cli = join(repo, 'bin', 'learn-from-mistakes-axi.mjs');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const ENVIRONMENTS = ['plain', 'firstmate'];

// The words of one phrase, matched anywhere in a text: the words in order, anything between them. A word boundary
// only where the phrase starts or ends with a letter or a digit: a phrase that ends in a dot or a question mark has
// none there.
const phrase = (text) => {
  const body = String(text).trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\W+');
  return new RegExp(`${/^\w/.test(body) ? '\\b' : ''}${body}${/[A-Za-z0-9_]$/.test(body) ? '\\b' : ''}`, 'i');
};
const holds = (text, words) => words.some((w) => phrase(w).test(text));
const norm = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
// The start of a record's text, up to a word boundary: the report cuts the text short, so the start is what it shows.
const start = (text, chars = 40) => {
  const cut = norm(text).slice(0, chars);
  return cut.slice(0, cut.lastIndexOf(' ')).trim();
};
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const at = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

// The scratch: one dir per run, with the agent PATH, the fake home and the two projects in it.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'lfm-frozen-five-'));
  for (const sub of ['bin', 'home', 'tmp', 'plain', 'firstmate']) mkdirSync(join(dir, sub), { recursive: true });
  // The PATH holds only the recorded agent, node and git: the real agents of the host can never be called.
  const agent = join(fixtures, 'recorded-agent');
  for (const name of ['claude', 'codex']) symlinkSync(agent, join(dir, 'bin', name));
  symlinkSync(process.execPath, join(dir, 'bin', 'node'));
  const git = process.env.PATH.split(delimiter).map((d) => join(d, 'git')).find(existsSync);
  if (git) symlinkSync(git, join(dir, 'bin', 'git'));
  return dir;
}

// One project: the defect log with the cases that are not complaints, the chat file with the complaint, and the
// config with one cause per case.
function project(dir, env) {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'state'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  const log = [], chat = [];
  for (const c of set.cases) for (const r of c.records) {
    if (c.complaint && env === 'firstmate') chat.push(r);
    else log.push(r);
  }
  log.push(set.bystander);
  const byDay = new Map();
  for (const r of log) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  const lines = ['# Defect log', ''];
  for (const [d, records] of [...byDay].sort((a, b) => a[0] - b[0])) {
    lines.push(`## ${day(d)}`, '');
    for (const r of records) lines.push(`- [${r.area}] ${r.text}`);
    lines.push('');
  }
  writeFileSync(join(dir, 'defects.md'), `${lines.join('\n')}\n`);
  const rows = ['at\twork\ttext'];
  for (const r of chat) rows.push(`${at(r.day)}\t${r.work ?? 'sample-page'}\t${r.text}`);
  writeFileSync(join(home, 'data', 'chat.tsv'), `${rows.join('\n')}\n`);
  const config = {
    name: `frozen-five-${env}`,
    sources: { log: { type: 'markdown-log', path: 'defects.md' }, ...(env === 'firstmate' ? { home: { type: 'firstmate', path: home } } : {}) },
    causes: Object.fromEntries(set.cases.map((c) => [c.cause, { description: c.cause_description }])),
    agent: 'claude', judge_agent: 'codex',
    agent_config: { claude: { model: 'recorded-worker' }, codex: { model: 'recorded-judge' } },
    window: '7d', excerpts: 'on', signoff: 'off',
  };
  writeFileSync(join(dir, '.learn-from-mistakes.yaml'), stringify(config));
}

// The retro, in the scratch: the recorded agent answers every step.
function retro(dir, env, unrelated) {
  const projectDir = join(dir, env);
  project(projectDir, env);
  const runEnv = { ...process.env, HOME: join(dir, 'home'), LFM_HOME: join(dir, 'home', '.learn-from-mistakes'), TMPDIR: join(dir, 'tmp'),
    PATH: join(dir, 'bin'), SIGN_OFF_HOME: join(dir, 'home'), LFM_TEST_MODE: '1', LFM_TEST_BOARD_ROOT: dir,
    LFM_FROZEN_UNRELATED: unrelated ? '1' : '0' };
  delete runEnv.CLAUDE_CONFIG_DIR; // the recorded agent reads no login of any agent
  delete runEnv.CODEX_HOME;
  const run = spawnSync(process.execPath, [cli, 'retro', '--foreground', '--json', '--dir', projectDir], { encoding: 'utf8', env: runEnv });
  if (run.status !== 0) throw new Error(`the retro in ${env} failed (${run.status}): ${run.stderr || run.stdout}`);
  const out = JSON.parse(run.stdout);
  if (out.run?.status !== 'completed') throw new Error(`the retro in ${env} did not complete: ${JSON.stringify(out.run)}`);
  return { id: out.run.id, project: projectDir, dir: join(projectDir, '.lfm', 'runs', String(out.run.id)) };
}

// The findings the run kept: the judge's verdict, the summary, the why chain and the cost.
function findings(run) {
  const db = new DatabaseSync(join(run.project, '.lfm', 'lfm.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT cause, summary, whys_json, cost, verdict FROM findings WHERE run_id = ? ORDER BY id').all(run.id)
      .map((f) => ({ cause: f.cause, summary: f.summary, whys: JSON.parse(f.whys_json ?? '[]'), cost: f.cost ?? '', verdict: f.verdict }));
  } finally { db.close(); }
}

// One section of report.txt: the lines under its heading, up to the blank line that ends it.
const section = (report, name) => report.split(`${name}\n`)[1]?.split('\n\n')[0] ?? '';

// One environment, scored.
function score(dir, env, unrelated) {
  const run = retro(dir, env, unrelated);
  const report = readFileSync(join(run.dir, 'report.txt'), 'utf8');
  const kept = findings(run).filter((f) => f.verdict !== 'refuted');
  const named = kept.map((f) => [f.summary, ...f.whys, f.cost].join(' ')).join('\n');
  const listed = section(report, '6. Not checked');
  const verdicts = {};
  for (const c of set.cases) {
    const found = holds(named, c.names);
    // The words that name the case in the report: the start of its record's own text, or the worker's stored explanation.
    const words = [...c.records.map((r) => start(r.text)), c.why];
    verdicts[c.id] = found ? 'found' : holds(listed, words) ? 'listed' : 'missing';
  }
  const counts = { found: 0, listed: 0, missing: 0 };
  for (const v of Object.values(verdicts)) counts[v]++;
  return { env, run: run.id, report: join(run.dir, 'report.txt'), findings: kept.map((f) => ({ cause: f.cause, summary: f.summary, verdict: f.verdict })),
    verdicts, counts, notChecked: listed, repeated: section(report, '4. Repeated mistakes').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) };
}

// The standing: each case and its verdict in each environment.
function measure(unrelated) {
  const dir = scratch();
  try {
    const environments = Object.fromEntries(ENVIRONMENTS.map((env) => [env, score(dir, env, unrelated)]));
    return { cases: set.cases.map((c) => ({ id: c.id, name: c.name, kind: c.kind })), environments };
  } finally {
    if (flag('--keep')) console.error(`kept: ${dir}`);
    else rmSync(dir, { recursive: true, force: true }); // the scratch this run made
  }
}

// The baseline: the standing the set measured, so a change that moves it is visible.
function compare(standing) {
  if (!existsSync(baselineFile)) return { baseline: false, moved: [] };
  const base = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const moved = [];
  for (const env of ENVIRONMENTS) for (const c of set.cases) {
    const was = base.environments?.[env]?.[c.id], now = standing.environments[env].verdicts[c.id];
    if (was !== now) moved.push({ env, case: c.id, was: was ?? 'not measured', now });
  }
  return { baseline: true, moved };
}

let standing, moved;
try {
  standing = measure(!flag('--no-unrelated'));
  moved = compare(standing);
} catch (e) {
  console.error(`frozen five: ${e.message}`);
  process.exit(1);
}
if (flag('--update')) writeFileSync(baselineFile, `${JSON.stringify({ note: 'The standing the frozen set measured. Regenerate with node scripts/frozen-five.mjs --update.', environments: Object.fromEntries(ENVIRONMENTS.map((env) => [env, standing.environments[env].verdicts])) }, null, 2)}\n`);
if (flag('--json')) console.log(JSON.stringify({ ...standing, baseline: moved }, null, 2));
else {
  const width = Math.max(...set.cases.map((c) => c.name.length), 20);
  console.log('Frozen five: five made-up mistakes, run through the real retro with and without Firstmate sources.');
  console.log('The worker and the judge answers are recorded, so this run needs no model, no key and no network.');
  console.log('');
  console.log(`case${' '.repeat(width - 4)}  plain      firstmate`);
  for (const c of set.cases) console.log(`${c.name}${' '.repeat(width - c.name.length)}  ${standing.environments.plain.verdicts[c.id].padEnd(9)}  ${standing.environments.firstmate.verdicts[c.id]}`);
  console.log('');
  for (const env of ENVIRONMENTS) {
    const c = standing.environments[env].counts;
    console.log(`${env}: ${c.found} found, ${c.listed} listed, ${c.missing} missing`);
    console.log(`  report: ${standing.environments[env].report}`);
  }
  console.log('');
  if (flag('--update')) console.log(`wrote the baseline: ${baselineFile}`);
  else console.log(moved.baseline ? (moved.moved.length ? `the standing moved: ${moved.moved.map((m) => `${m.env}/${m.case} ${m.was} -> ${m.now}`).join(', ')}` : 'the standing matches the baseline')
    : 'no baseline yet: write one with node scripts/frozen-five.mjs --update');
}
if (flag('--check') && moved.moved.length) process.exit(1);
