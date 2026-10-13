// done-done: the verify runs done-done keeps for the apps the user names, read-only from its run store,
// <path>/runs/<app>/<run-id>/run.json (path: done-done's home, by default $DONE_DONE_HOME, else ~/.done-done, as done-done
// documents it). Each failed step of a verify run that failed, was inconclusive or was overridden at its gate (done-done
// counts that a fail) is one record: its day, the step, a short reason (redacted) and the run file as its ref; a run with
// no failed step is one record for the step its reason names (setup: an error before the first step). Passed, cancelled
// and unfinished runs are not records. A run file in a schema this version does not read stops the read with the fix;
// it is never skipped.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { expand, mapping } from '../config.mjs';
import { excerpt } from '../redact.mjs';

const SCHEMA = 2;

export function validate(s, where, dir) {
  mapping(s, ['type', 'apps', 'path'], where);
  if (!Array.isArray(s.apps) || !s.apps.length || !s.apps.every((a) => typeof a === 'string' && /^(?!\.\.?$)[^/\\\0]+$/.test(a))) {
    throw new UsageError(`${where}.apps must be a list of done-done app names`);
  }
  if (s.path !== undefined && (typeof s.path !== 'string' || !s.path)) throw new UsageError(`${where}.path must be a string`);
  const home = s.path === undefined ? (process.env.DONE_DONE_HOME ? resolve(process.env.DONE_DONE_HOME) : join(homedir(), '.done-done')) : expand(s.path, dir);
  return { type: s.type, apps: [...new Set(s.apps)], path: home };
}

// Returns the records, and the apps with no runs folder (doctor warns: a typo in an app name reads nothing).
export function read(source, { apps, path }, { project }) {
  const records = [], missing = [];
  for (const app of apps) {
    const root = join(path, 'runs', app);
    let ids;
    try { ids = readdirSync(root).sort(); } catch (e) {
      if (e.code === 'ENOENT') { missing.push(app); continue; }
      throw new UsageError(`source ${source}: cannot read ${root} (${e.code})`, `chmod -R u+r ${shq(root)}   # the tool only reads it`);
    }
    for (const id of ids) {
      const file = join(root, id, 'run.json');
      const bad = (why) => new UsageError(`source ${source}: ${file} is not done-done run state (${why})`,
        `done-done status --run ${id}   # in the ${app} repo: done-done's own read of that run; or remove sources.${source} from ${shq(project)}`);
      let run;
      try { run = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
        if (['ENOENT', 'ENOTDIR'].includes(e.code)) continue; // not a run folder, such as the judge cache
        if (e.code) throw new UsageError(`source ${source}: cannot read ${file} (${e.code})`, `chmod -R u+r ${shq(root)}   # the tool only reads it`);
        throw bad('not JSON');
      }
      if (run?.schema !== SCHEMA) {
        throw new UsageError(`source ${source}: ${file} is done-done run schema ${String(JSON.stringify(run?.schema)).slice(0, 20)}; this version reads schema ${SCHEMA}`,
          `update learn-from-mistakes-axi to read it, or remove sources.${source} from ${shq(project)}`);
      }
      if (!Array.isArray(run.steps) || !run.steps.every((s) => typeof s?.name === 'string')) throw bad('steps');
      if (run.kind !== 'verify' || !(run.status === 'failed' || (run.status === 'completed' && ['fail', 'inconclusive', 'overridden'].includes(run.result)))) continue;
      const failed = run.steps.filter((s) => s.status === 'failed');
      const reason = typeof run.reason === 'string' ? run.reason : '', named = reason.match(/^([\w-]+):/)?.[1] ?? 'run';
      for (const s of failed.length ? failed : [run.steps.find((x) => x.name === named) ?? { name: named }]) {
        // The run's reason when it names this step, else the step's own first finding, else its exit.
        const found = Array.isArray(s.findings) ? s.findings[0]?.why ?? s.findings[0]?.what : undefined;
        const why = reason.startsWith(`${s.name}:`) ? reason : typeof found === 'string' ? `${s.name}: ${found}`
          : failed.length ? `${s.name}: failed${s.exit === undefined ? '' : ` (exit ${s.exit})`}` : reason || `${s.name}: no reason saved`;
        records.push({ id: `${source}:${app}/${id}/${s.name}`, source, step: s.name, ref: file,
          date: String(s.ended ?? run.updated ?? '').slice(0, 10), text: excerpt(`verify ${run.result ?? 'failed'}: ${why}`) });
      }
    }
  }
  return { records, missing, hash: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}

// doctor: readable, the failed steps in the window, and the apps with no runs (a warn with the fix).
export function doctor(source, entry, { readFrom, project }) {
  const { records, missing } = read(source, entry, { project });
  const detail = `${records.length} failed or inconclusive verify steps, ${records.filter((r) => Date.parse(r.date) >= readFrom).length} in the window`;
  if (!missing.length) return { level: 'ok', detail };
  return { level: 'warn', detail: `${detail}; no runs for ${missing.join(', ')} in ${join(entry.path, 'runs')}`,
    fix: `ls ${shq(join(entry.path, 'runs'))}   # done-done's app names; set sources.${source}.apps in ${shq(project)} to them, or sources.${source}.path to done-done's home` };
}
