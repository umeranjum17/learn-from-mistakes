// End-to-end: the real CLI runs `init` in a throwaway git repo, with fake agent CLIs (PATH holds only them), a throwaway
// HOME and LFM_HOME, and a synthetic no-mistakes store under NM_HOME that has a row for the repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { parse } from 'yaml';

const CLI = process.env.LFM_CLI || new URL('../bin/learn-from-mistakes-axi.mjs', import.meta.url).pathname;
const MODELS = JSON.parse(readFileSync(new URL('../src/models.json', import.meta.url), 'utf8'));

function setup(agents) {
  const tmp = mkdtempSync(join(tmpdir(), 'lfm-init-'));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const p = join(tmp, 'umer-app'), bin = join(tmp, 'bin'), nm = join(tmp, 'nm');
  for (const d of [join(p, 'docs'), bin, nm]) mkdirSync(d, { recursive: true });
  execFileSync('git', ['-C', p, 'init', '-q']);
  writeFileSync(join(p, 'docs', 'defects.md'), readFileSync(new URL('../examples/defects.md', import.meta.url)));
  for (const name of agents) {
    writeFileSync(join(bin, name), '#!/bin/sh\necho "1.0.0"\n');
    chmodSync(join(bin, name), 0o755);
  }
  copyFileSync(new URL('../examples/gate.sqlite', import.meta.url), join(nm, 'state.sqlite'));
  const db = new DatabaseSync(join(nm, 'state.sqlite'));
  db.exec('CREATE TABLE repos (id TEXT PRIMARY KEY, working_path TEXT NOT NULL, upstream_url TEXT NOT NULL)');
  db.prepare('INSERT INTO repos VALUES (?, ?, ?)').run('r1', realpathSync(p), 'https://example.com/umer/umer-app.git');
  db.close();
  const env = { PATH: bin, HOME: join(tmp, 'home'), LFM_HOME: join(tmp, 'lfm-home'), NM_HOME: nm };
  const lfm = (...args) => spawnSync(process.execPath, [CLI, ...args, '--dir', p], { encoding: 'utf8', env });
  const config = join(p, '.learn-from-mistakes.yaml');
  return { p, nm, lfm, config };
}

test('init writes a working config once: a worker and a different judge, the sources found, a git-ignored .lfm', () => {
  const { p, nm, lfm, config } = setup(['claude', 'opencode']);
  const r = lfm('init', '-y', '--no-skill', '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'written');
  assert.deepEqual([out.worker, out.judge], [{ runner: 'claude', model: MODELS.claude[0] }, { runner: 'opencode', model: MODELS.opencode[0] }]);
  assert.deepEqual(out.gaps, []);
  const yaml = parse(readFileSync(config, 'utf8'));
  assert.deepEqual(yaml, { name: 'umer-app', worker: { runner: 'claude', model: '' }, judge: { runner: 'opencode', model: '' }, excerpts: 'on',
    sources: { log: { type: 'markdown-log', path: 'docs/defects.md' }, gate: { type: 'no-mistakes', path: join(nm, 'state.sqlite') } } });
  assert.equal(readFileSync(join(p, '.lfm', '.gitignore'), 'utf8'), '*\n');
  assert.equal(execFileSync('git', ['-C', p, 'status', '--short'], { encoding: 'utf8' }), '?? .learn-from-mistakes.yaml\n?? docs/\n');
  const text = lfm('init');
  assert.match(text.stdout, /^excerpts on: the worker \(claude\) and the judge \(opencode\) see redacted record excerpts/m);

  const bytes = readFileSync(config);
  const again = lfm('init', '--json');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).status, 'already set up');
  assert.deepEqual(readFileSync(config), bytes);
  const run = lfm('retro', '--foreground', '--json'); // the written config runs: both detected sources are read
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).run.status, 'completed');

  writeFileSync(config, 'sources: {}\n'); // an existing config is never rewritten; its gaps are listed
  const gaps = JSON.parse(lfm('init', '--no-excerpts', '--json').stdout);
  assert.deepEqual(gaps.gaps, ['sources: markdown-log found at docs/defects.md, not configured (add it as log)',
    'sources: no-mistakes found at ' + join(nm, 'state.sqlite') + ', not configured (add it as gate)']);
  assert.equal(readFileSync(config, 'utf8'), 'sources: {}\n');
  rmSync(config);
  assert.equal(lfm('init', '--no-excerpts').status, 0);
  assert.equal(parse(readFileSync(config, 'utf8')).excerpts, 'off');
});

test('one agent CLI with one table model: the judge is written on the worker\'s identity and reported, never a silent fallback', () => {
  const { lfm, config } = setup(['claude']);
  const r = lfm('init', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).gaps, ['judge: the judge resolves to the worker\'s agent and model, so it would judge its own work']);
  assert.match(r.stderr, /^next: set judge\.model in \.learn-from-mistakes\.yaml to a different model, or install a second agent CLI$/m);
  assert.deepEqual(parse(readFileSync(config, 'utf8')).judge, { runner: 'claude', model: '' });
  const agents = lfm('agents'); // the clash fails every later check of the config
  assert.equal(agents.status, 1);
  assert.match(agents.stderr, /^problem: judge: the judge resolves to the worker's agent/m);
});

test('init refuses a pinned judge on the worker\'s identity, an unknown runner and no agent CLI, and writes nothing', () => {
  const { lfm, config } = setup(['claude', 'opencode']);
  for (const [args, code, error] of [
    [['--worker', 'claude', '--judge', 'claude'], 2, 'error: judge: the judge resolves to the worker\'s agent and model, so it would judge its own work'],
    [['--worker', 'umer'], 2, 'error: --worker "umer" must be a runner: claude, codex, opencode'],
    [['--judge', 'codex'], 1, 'error: judge: codex is not usable: codex is not on PATH'],
  ]) {
    const r = lfm('init', ...args);
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.stderr.split('\n')[0], error);
    assert.match(r.stderr, /^next: /m);
    assert.ok(!existsSync(config), `${args.join(' ')} wrote a config`);
  }
  const none = setup([]).lfm('init');
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^error: worker: no usable agent CLI/);
});
