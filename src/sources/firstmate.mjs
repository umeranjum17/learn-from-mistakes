// firstmate: the records of a Firstmate home the user names (opt-in: `init --firstmate <home>` or a hand-written
// source; never detected), read-only. Under <home>/state: each *.status file is a status log, one
// `<state> [at=<epoch>] [<tag>...]: <text>` line per entry, where a line with no at= stamp takes the last stamp above
// it; each *.msg file in a *.inbox folder (or its handled/ folder) is one inbox message, timed by its `at=<epoch>`
// line and tagged by its first [tag]. A needs-decision line is a decision, a blocked line a block, a message a steer.
// <home>/data/defects.md is read as a markdown-log defect log. <home>/config/targets.tsv, one
// `metric<TAB>op<TAB>target<TAB>owner<TAB>rule` line per target, overrides the config's targets.
// An entry with no time is skipped and counted.
// With fleet: true the source reads the whole fleet: the home it names (the main home, whose targets count) and each
// secondmate home its data/secondmates.md lists, one `- <id> - <summary> (home: <absolute path>; ...)` line each; a
// bullet with no local home (a remote route, or no absolute home: path) is skipped and counted. Each record keeps its
// home as a salted id (data.home, and its record id's prefix), never the home's name or path; the store keeps the path.
// A home that cannot be read stops the read.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readText, shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { pathSource, RULE } from '../config.mjs';
import { inWindow } from '../metrics.mjs';
import { excerpt, redact } from '../redact.mjs';
import * as markdownLog from './markdown-log.mjs';

const KINDS = { 'needs-decision': 'decision', blocked: 'block' };

// The home's targets, by metric: "<op> <target>". Owner and rule are the home's own columns; the run keeps the target only.
export function validate(s, where, dir) {
  const { type, path, fleet } = pathSource(s, where, dir, ['fleet']), file = join(path, 'config', 'targets.tsv'), targets = {};
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new UsageError(`${file}: cannot read (${e.code})`); }
  text.split('\n').forEach((line, i) => {
    const cols = line.split('\t');
    if (!line.trim() || line.startsWith('#') || cols[0] === 'metric') return;
    if (cols.length !== 5 || !RULE.test(`${cols[1]} ${cols[2]}`)) throw new UsageError(`${file}:${i + 1}: a target line is metric, op, target, owner and rule, tab-separated, such as blocks<TAB><=<TAB>2<TAB>Umer<TAB>R1`);
    targets[cols[0]] = `${cols[1]} ${cols[2]}`;
  });
  if (fleet !== undefined && typeof fleet !== 'boolean') throw new UsageError(`${where}.fleet must be true or false`);
  return { type, path, ...(fleet && { fleet }), targets, targets_file: file };
}

// The fleet's homes: the main home, then each secondmate home its registry lists once; `lines` counts the bullets skipped.
function fleetHomes(source, path, project) {
  const file = join(path, 'data', 'secondmates.md'), homes = [path];
  let lines = 0;
  for (const line of readText(file, `source ${source}: ${file}`, `set sources.${source}.fleet to false in ${shq(project)} to read the main home alone`).split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const home = line.match(/\(home: ([^;)]+?)\s*[;)]/)?.[1];
    if (!home || !isAbsolute(home)) lines += 1;
    else if (!homes.includes(resolve(home))) homes.push(resolve(home));
  }
  return { homes, lines, file };
}

export function read(source, entry, ctx) {
  const fleet = entry.fleet && fleetHomes(source, entry.path, ctx.project), records = [], ids = [];
  let skipped = 0;
  for (const [i, home] of (fleet ? fleet.homes : [entry.path]).entries()) {
    const id = fleet && markdownLog.saltedId(ctx.salt, home);
    const got = readHome(source, home, ctx, id, i ? `fix or remove the line of ${home} in ${shq(fleet.file)}, the fleet registry source ${source} reads` : undefined);
    for (const r of got.records) records.push(r); // one push per record, as below
    skipped += got.skipped;
    ids.push(id);
  }
  return { records, skipped, ...(fleet && { homes: ids, lines_skipped: fleet.lines }), hash: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}

// One home's records; with a home id, each record's id starts with it and its data names it.
function readHome(source, path, { readFrom = 0, excerpts = true, project, salt }, home, fix) {
  const state = join(path, 'state'), records = [], text = (t) => (excerpts ? excerpt(t) : ''), at = home ? `${home}/` : '';
  let files, skipped = 0;
  try { files = readdirSync(state, { recursive: true }).sort(); } catch (e) {
    throw new UsageError(`source ${source}: cannot read ${state} (${e.code})`, fix ?? `set sources.${source}.path in ${shq(project)} to the Firstmate home that holds state/, or remove that source`);
  }
  const add = (ms, id, ref, kind, body, tag) => {
    if (Number.isNaN(new Date(ms).getTime())) skipped += 1; // no stamp, or one that is not a time
    else if (ms >= readFrom) records.push({ id: at + id, source, ref, date: new Date(ms).toISOString().slice(0, 10), text: text(body), data: { kind, ...(home && { home }), ...(tag && excerpts && { tag: redact(tag) }) } });
  };
  const read1 = (f) => readText(join(state, f), `source ${source}`, `chmod -R u+r ${shq(state)}   # the tool only reads it`);
  for (const f of files.filter((n) => /^[^/]+\.status$/.test(n))) {
    let at = NaN;
    read1(f).split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/^([a-z-]+)((?: \[[^\]]*\])*): (.*)$/);
      if (!m) return;
      const stamp = m[2].match(/\[at=([^\]]*)\]/)?.[1];
      if (stamp !== undefined) at = /^\d+$/.test(stamp) ? Number(stamp) * 1000 : NaN; // a stamp that is not digits is no time
      if (Object.hasOwn(KINDS, m[1])) add(at, `${f}:${i + 1}`, `${join(state, f)}:${i + 1}`, KINDS[m[1]], m[3]);
    });
  }
  for (const f of files.filter((n) => /^[^/]+\.inbox\/(handled\/)?[^/]+\.msg$/.test(n))) {
    const body = read1(f), stamp = body.match(/^at=(\d+)\r?$/m)?.[1];
    add(stamp ? Number(stamp) * 1000 : NaN, f, join(state, f), 'steer', body.replace(/^at=\d+\r?$/m, ''), body.match(/^(?:at=\d+\r?\n)?\[([^\]\s]+)\]/)?.[1]);
  }
  const log = join(path, 'data', 'defects.md');
  if (existsSync(log)) {
    // One push per record: spreading an unbounded array overflows the call stack.
    for (const r of markdownLog.read(source, { path: log }, { project, salt }).records)
      records.push({ ...r, id: `${at}defects:${r.id}`, ref: `${log}:${r.line}`, data: { kind: 'defect', ...(home && { home }) } });
  }
  return { records, skipped };
}

// doctor: readable, the decisions, blocks and steers in the window, and the entries with no time; for a fleet, its homes
// and the registry lines with no local home.
export function doctor(source, entry, ctx) {
  const { records, skipped, homes, lines_skipped } = read(source, entry, ctx), n = (kind) => records.filter((r) => r.data.kind === kind).length;
  const fleet = homes ? `${homes.length} homes, ${lines_skipped} registry lines skipped (no local home), ` : '';
  return { level: 'ok', detail: `${fleet}${n('decision')} decisions, ${n('block')} blocks, ${n('steer')} steers, ${n('defect')} defect records, ${skipped} skipped (no time)` };
}

// decisions, blocks and steers in the window; interventions_per_merge is their sum over the PRs merged (n/a with no
// github source or no merge). The home's dated defect records add to defects.
export const metricNames = ['decisions', 'blocks', 'steers', 'interventions_per_merge'];
export const addsTo = ['defects']; // the follow-up step reads this source's records for these metrics too
export const metricRows = 'records';
export function metrics(rows, window, v) {
  const of = (kind) => inWindow(rows.filter((r) => JSON.parse(r.data).kind === kind), window);
  const out = { decisions: of('decision').length, blocks: of('block').length, steers: of('steer').length };
  const defects = rows.filter((r) => r.ts && JSON.parse(r.data).kind === 'defect');
  return { ...out, interventions_per_merge: v.merged ? (out.decisions + out.blocks + out.steers) / v.merged : null,
    ...(defects.length && { defects: (v.defects ?? 0) + of('defect').length }) };
}
