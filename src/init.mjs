// init: write a project's .learn-from-mistakes.yaml once. The worker and the judge are agent CLIs from the runner
// table, picked by the identity rule; the sources are what the registry's detect hooks find in the project.
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { InputError, stateDir, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { expand, loadConfig, loadGlobal, PROJECT_FILE, SOURCES } from './config.mjs';
import { detect, resolveRoles } from './runners/index.mjs';

const ID = { 'markdown-log': 'log', 'no-mistakes': 'gate', github: 'prs' }; // the id a detected source is written under; else its type
const FIX = 'learn-from-mistakes-axi agents   # the agent CLIs found, and why one is not usable';
const scalar = (v) => JSON.stringify(v); // a JSON string is a YAML scalar
const flow = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${scalar(v)}`).join(', ')} }`;

// Writes the config when the project has none; otherwise leaves it as it is, and the flags that would have changed it
// are returned as ignored. Either way it makes the state dir and returns the config as loaded, plus its gaps: a role
// that does not resolve, or a detected source the config lacks.
export async function init(dir, opts) {
  const file = join(dir, PROJECT_FILE);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`${dir}: not a directory`, 'learn-from-mistakes-axi init --dir <project>   # an existing project dir');
  const changes = ['worker', 'judge', 'no-excerpts'].filter((k) => opts[k]).map((k) => `--${k}`);
  const found = {}, skipped = [];
  for (const [type, mod] of Object.entries(SOURCES)) {
    try {
      const entry = await mod.detect?.(dir);
      if (entry) found[ID[type] ?? type] = entry;
    } catch (e) { skipped.push(`${type}: ${e.message}`); }
  }
  const global = loadGlobal();
  const agents = detect(global);
  const written = !existsSync(file);
  if (written) {
    const want = { ...global, worker: { runner: opts.worker ?? 'auto', model: '' }, judge: { runner: opts.judge ?? 'auto', model: '' } };
    const { worker, judge } = await resolveRoles(want, agents, {});
    // A pinned judge with no worker that differs from it is refused, as is a judge pinned onto the worker's identity.
    if (worker.problem) {
      if (opts.judge && !opts.worker && judge.bin) throw new UsageError(`worker: ${worker.problem}`, `learn-from-mistakes-axi init --worker <runner> --judge ${opts.judge}   # a worker on another agent CLI`);
      throw new InputError(`worker: ${worker.problem}`, FIX);
    }
    if (judge.problem && !judge.bin) throw new InputError(`judge: ${judge.problem}`, FIX);
    // An auto judge with no second identity is written and reported; a judge the user pinned onto the worker is refused.
    if (judge.problem && opts.judge) throw new UsageError(`judge: ${judge.problem}`, `learn-from-mistakes-axi init --worker <runner> --judge ${opts.judge}   # a worker on another agent CLI`);
    try {
      writeFileSync(file, `# written by learn-from-mistakes-axi init
name: ${scalar(basename(dir))}
worker: ${flow({ runner: worker.runner, model: '' })}   # "" = the runner's default model
judge: ${flow({ runner: judge.runner, model: '' })}   # its agent CLI and model must differ from the worker's
excerpts: ${opts['no-excerpts'] ? 'off' : 'on'}   # on: the worker and judge see redacted record excerpts; off: pointers and counts only
sources:${Object.keys(found).length ? '' : ' {}'}
${Object.entries(found).map(([id, s]) => `  ${id}: ${flow(s)}\n`).join('')}`, { flag: 'wx' });
    } catch (e) { throw new UsageError(`${file}: cannot write (${e.code})`, `ls -la ${dir}   # init writes ${PROJECT_FILE} there`); }
  }
  const cfg = loadConfig(dir);
  stateDir(cfg);
  const { worker, judge } = await resolveRoles(cfg, agents, {});
  const gaps = [...Object.entries({ worker, judge }).filter(([, r]) => r.problem).map(([name, r]) => `${name}: ${r.problem}`),
    ...Object.entries(found).filter(([, s]) => !Object.values(cfg.sources).some((c) => c.type === s.type && (!s.path || c.path === expand(s.path, dir))))
      .map(([id, s]) => `sources: ${s.type} found${s.path ? ` at ${s.path}` : ''}, not configured (add it as ${id})`)];
  return {
    config: file, status: written ? 'written' : 'already set up', ignored: written ? [] : changes,
    worker: { runner: worker.runner, model: worker.model }, judge: { runner: judge.runner, model: judge.model }, workerBin: worker.bin, judgeBin: judge.bin, anyUsable: agents.some((a) => a.usable),
    excerpts: cfg.excerpts, sources: Object.fromEntries(Object.entries(cfg.sources).map(([id, s]) => [id, s.path ? { type: s.type, path: s.path } : { type: s.type }])),
    gaps, skipped,
  };
}
