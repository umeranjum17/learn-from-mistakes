// firstmate: the records of a Firstmate home the user names (opt-in: `init --firstmate <home>` or a hand-written
// source; never detected), read-only. Under <home>/state: each *.status file is a status log, one
// `<state> [at=<epoch>] [<tag>...]: <text>` line per entry, where a line with no at= stamp takes the last stamp above
// it; each *.msg file in a *.inbox folder (or its handled/ folder) is one inbox message, timed by its `at=<epoch>`
// line and tagged by its first [tag]. A needs-decision line is a decision, a blocked line a block, a message a steer.
// <home>/data/defects.md is read as a markdown-log defect log. <home>/data/metrics/prs.tsv (one merged PR a row: merged,
// hours_to_merge, rework_*, reverted, escaped, bot, title) gives the PR metrics when no github source does, and
// <home>/data/metrics/daily.tsv (one day and project a row: day, steers, s_correct) gives the steers, ahead of the inbox
// messages, and the corrections. <home>/data/chat.tsv (header `at<TAB>work<TAB>text`, one chat line a row, at an epoch)
// holds the captain's chat lines: each whose text has the word why, wrong or again is a complaint, a mistake record with its
// text, time and work (the task or PR it points at); the other lines are no mistake. A home that lacks either file reads without it. A message with no at= line is timed by
// the epoch its file name starts with, as Firstmate names handled messages `<epoch>-<id>.msg`. <home>/config/targets.tsv, one
// `metric<TAB>op<TAB>target<TAB>owner<TAB>rule` line per target, overrides the config's targets.
// A status line also opens a stage (src/stages.mjs) that lasts until the next line's stamp; its hours feed the stage metrics.
// An entry with no time is skipped and counted.
// With fleet: true the source reads the whole fleet: the home it names (the main home, whose targets count) and each
// secondmate home its data/secondmates.md lists, one `- <id> - <summary> (home: <absolute path>; ...)` line each; a
// bullet with no local home (a remote route, or no absolute home: path) is skipped and counted. Each record keeps its
// home as a salted id (data.home, and its record id's prefix), never the home's name or path; the store keeps the path.
// A home whose folder is missing stops the read; a listed home whose folder exists but has no state/ reads as empty.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readText, shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { pathSource, RULE } from '../config.mjs';
import { inWindow } from '../metrics.mjs';
import { excerpt, redact } from '../redact.mjs';
import { STAGES, STAGE_METRICS, stageOf, WORKING } from '../stages.mjs';
import * as github from './github.mjs';
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

// A registry bullet's route: the `home:` and `host:` pairs of its parenthesised group that names one, `;`-separated, in
// any order. Other segments are ignored; a home path is cut at the next `;` or `)`.
function registryRoute(line) {
  const m = [...line.matchAll(/\(([^)]*)\)/g)].find((g) => /(^|;)\s*(home|host)\s*:/.test(g[1]));
  const route = {};
  for (const pair of m ? m[1].split(';') : []) {
    const colon = pair.indexOf(':'), key = colon > 0 ? pair.slice(0, colon).trim() : '';
    if (key === 'home' || key === 'host') route[key] = pair.slice(colon + 1).trim();
  }
  return route;
}

// The fleet's homes: the main home, then each secondmate home its registry lists, with the registry line that lists it
// (`rows`); `lines` counts the bullets skipped.
function fleetHomes(source, path, project) {
  const file = join(path, 'data', 'secondmates.md'), homes = [path], rows = [undefined];
  let lines = 0;
  const text = existsSync(file) ? readText(file, `source ${source}: ${file}`, `set sources.${source}.fleet to false in ${shq(project)} to read the main home alone`) : '';
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.startsWith('- ')) return;
    const route = registryRoute(line), home = route.home?.replace(/^~(?=\/|$)/, homedir());
    if ('host' in route || !home || !isAbsolute(home)) lines += 1;
    else { homes.push(resolve(home)); rows.push(i + 1); }
  });
  return { homes, rows, lines, file };
}

const realHome = (home) => { try { return realpathSync(home); } catch { return resolve(home); } };

// A home is read by one source only: two sources, or one registry, naming the same home would count its records twice.
export function checkHomes(sources, project) {
  const seen = new Map();
  for (const [id, s] of Object.entries(sources)) {
    if (s.type !== 'firstmate') continue;
    const fleet = s.fleet ? fleetHomes(id, s.path, project) : { homes: [s.path] };
    fleet.homes.forEach((home, i) => {
      const real = realHome(home), prev = seen.get(real);
      if (prev === undefined) seen.set(real, id);
      else if (prev === id) throw new UsageError(`${project}: sources.${id} reads ${home} twice`, `fix or remove the line of ${home} in ${shq(fleet.file)}, line ${fleet.rows[i]}`);
      else throw new UsageError(`${project}: sources.${prev} and sources.${id} both read ${home}`, `remove ${home} from source ${prev} or source ${id}`);
    });
  }
}

export function read(source, entry, ctx) {
  const fleet = entry.fleet && fleetHomes(source, entry.path, ctx.project), records = [], ids = [];
  let skipped = 0, chat = 0, rows = 0;
  for (const [i, home] of (fleet ? fleet.homes : [entry.path]).entries()) {
    const id = fleet && markdownLog.saltedId(ctx.salt, home);
    const got = readHome(source, home, ctx, id, i ? `fix or remove the line of ${home} in ${shq(fleet.file)}, the fleet registry source ${source} reads` : undefined, i > 0);
    for (const r of got.records) records.push(r); // one push per record, as below
    skipped += got.skipped;
    chat += got.chat;
    rows += got.rows;
    ids.push(id);
  }
  // The metrics tables the first home lacks (a fleet's other homes may keep none), named so the report says which source is missing.
  const missing = ['prs.tsv', 'daily.tsv'].filter((t) => !records.some((r) => r.data.kind === (t === 'prs.tsv' ? 'pr' : 'daily'))).map((t) => `rows in ${t} under data/metrics of the home`);
  if (!chat) missing.push('rows in chat.tsv under data of the home'); // no chat lines read: the captain's complaints are unchecked, not absent
  return { records, skipped, ...(missing.length && { missing }), ...(fleet && { homes: ids, lines_skipped: fleet.lines }), chatRows: rows, hash: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}

// One home's records; with a home id, each record's id starts with it and its data names it.
function readHome(source, path, { readFrom = 0, excerpts = true, project, salt }, home, fix, listed) {
  const state = join(path, 'state'), records = [], text = (t) => (excerpts ? excerpt(t) : ''), at = home ? `${home}/` : '';
  const unreadable = (file, e) => new UsageError(`source ${source}: cannot read ${file} (${e.code})`, fix ?? `set sources.${source}.path in ${shq(project)} to the Firstmate home that holds state/, or remove that source`);
  // An entry that vanishes between the listing and its read (a lock folder, a message acknowledged into handled/) is no entry.
  const list = (dir, top) => {
    try { return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch (e) {
      if (top ? !listed || e.code !== 'ENOENT' || !existsSync(path) : !['ENOENT', 'ENOTDIR'].includes(e.code)) throw unreadable(dir, e);
      return [];
    }
  };
  // Only the status files and the inbox folders are opened: the lock folders that churn beside them are never entered.
  const files = [];
  let skipped = 0;
  for (const e of list(state, true)) {
    if (e.name.endsWith('.status') && !e.isDirectory()) files.push(e.name);
    else if (e.name.endsWith('.inbox') && e.isDirectory()) {
      const dir = join(state, e.name);
      for (const m of list(dir)) {
        if (m.name.endsWith('.msg') && !m.isDirectory()) files.push(`${e.name}/${m.name}`);
        else if (m.name === 'handled' && m.isDirectory()) for (const h of list(join(dir, 'handled'))) if (h.name.endsWith('.msg') && !h.isDirectory()) files.push(`${e.name}/handled/${h.name}`);
      }
    }
  }
  const add = (ms, id, ref, kind, body, tag, extra) => {
    if (Number.isNaN(new Date(ms).getTime())) skipped += 1; // no stamp, or one that is not a time
    else if (ms >= readFrom) records.push({ id: at + id, source, ref, date: new Date(ms).toISOString().slice(0, 10), text: text(body), data: { kind, ...(home && { home }), ...(tag && excerpts && { tag: redact(tag) }), ...extra } });
  };
  const read1 = (file) => {
    try { return readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return undefined;
      throw new UsageError(`source ${source}: cannot read ${file} (${e.code})`, `chmod -R u+r ${shq(dirname(file))}   # the tool only reads it`);
    }
  };
  for (const f of files.filter((n) => /^[^/]+\.status$/.test(n))) {
    let when = NaN;
    const lines = [];
    (read1(join(state, f)) ?? '').split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/^([a-z-]+)((?: \[[^\]]*\])*): (.*)$/);
      if (!m) return;
      const stamp = m[2].match(/\[at=([^\]]*)\]/)?.[1];
      if (stamp !== undefined) when = /^\d+$/.test(stamp) ? Number(stamp) * 1000 : NaN; // a stamp that is not digits is no time
      if (Object.hasOwn(KINDS, m[1])) add(when, `${f}:${i + 1}`, `${join(state, f)}:${i + 1}`, KINDS[m[1]], m[3]);
      lines.push({ when, line: i + 1, stage: stageOf(m[1], m[3]) });
    });
    // Each line's stage lasts until the next line's stamp. The last line has no end, and a line with no stamp, or a stamp
    // before the line above, times nothing; so a task still open, or a file with no stamps, adds no stage.
    const task = createHash('sha256').update(f).digest('hex').slice(0, 8);
    lines.slice(0, -1).forEach(({ when: from, line, stage }, i) => {
      const hours = (lines[i + 1].when - from) / 3_600_000;
      if (stage && Number.isFinite(from) && hours > 0) add(from, `${f}:${line}:stage`, `${join(state, f)}:${line}`, 'stage', '', undefined, { stage, hours, task });
    });
  }
  for (const f of files.filter((n) => /^[^/]+\.inbox\/(handled\/)?[^/]+\.msg$/.test(n))) {
    const body = read1(join(state, f));
    if (body === undefined) continue;
    const stamp = body.match(/^at=(\d+)\r?$/m)?.[1] ?? f.match(/\/(\d{9,})-[^/]*\.msg$/)?.[1];
    add(stamp ? Number(stamp) * 1000 : NaN, f, join(state, f), 'steer', body.replace(/^at=\d+\r?$/m, ''), body.match(/^(?:at=\d+\r?\n)?\[([^\]\s]+)\]/)?.[1]);
  }
  const log = join(path, 'data', 'defects.md');
  if (existsSync(log)) {
    // One push per record: spreading an unbounded array overflows the call stack.
    for (const r of markdownLog.read(source, { path: log }, { project, salt }).records)
      records.push({ ...r, id: `${at}defects:${r.id}`, ref: `${log}:${r.line}`, data: { kind: 'defect', ...(home && { home }) } });
  }
  // The home's metrics tables, one object a row keyed by its header, with the row's line number.
  const table = (name) => {
    const file = join(path, 'data', 'metrics', name), body = existsSync(file) ? read1(file) : undefined;
    if (!body) return [];
    const [head, ...lines] = body.split(/\r?\n/), cols = head.split('\t');
    return lines.flatMap((l, i) => (l.trim() ? [{ line: i + 2, file, row: Object.fromEntries(l.split('\t').map((v, j) => [cols[j], v])) }] : []));
  };
  const num = (v) => Number(v) || 0;
  const chatRows = table('../chat.tsv');
  for (const { line, file, row } of chatRows) {
    if (/\b(why|wrong|again)\b/i.test(row.text ?? '')) add(/^\d+$/.test(row.at) ? Number(row.at) * 1000 : NaN, `chat:${line}`, `${file}:${line}`, 'complaint', row.text, undefined, row.work ? { work: redact(row.work) } : undefined);
  }
  for (const { line, file, row } of table('prs.tsv')) {
    const hours = Number(row.hours_to_merge), ms = Number.isFinite(hours) ? Date.parse(row.merged) : NaN;
    add(ms, `pr:${line}`, `${file}:${line}`, 'pr', row.title ?? '', undefined, { bot: row.bot === '1', hours, rework_ci: num(row.rework_ci),
      rework_other: num(row.rework_other) + num(row.rework_pipeline), reverted: num(row.reverted), escaped: num(row.escaped) });
  }
  for (const { line, file, row } of table('daily.tsv')) add(Date.parse(row.day), `daily:${line}`, `${file}:${line}`, 'daily', '', undefined, { steers: num(row.steers), corrections: num(row.s_correct) });
  return { records, skipped, chat: chatRows.filter(({ row }) => row.text?.trim()).length, rows: chatRows.length }; // a row counts when it parsed into text: a file whose rows all fail to parse is no chat read
}

// The steers in the window: the daily table's, when the home keeps one, else the inbox messages'; the two are never added,
// as a daily row already counts the messages of its day.
const steersIn = (rows, window) => {
  const kind = (k) => rows.filter((r) => JSON.parse(r.data).kind === k);
  return kind('daily').length ? inWindow(kind('daily'), window).reduce((n, r) => n + JSON.parse(r.data).steers, 0) : inWindow(kind('steer'), window).length;
};

// doctor: readable, the decisions, blocks and steers in the window, and the entries with no time; for a fleet, its homes
// and the registry lines with no local home.
export function doctor(source, entry, ctx) {
  const { records, skipped, homes, lines_skipped, missing, chatRows } = read(source, entry, ctx), n = (kind) => records.filter((r) => r.data.kind === kind).length;
  const fleet = homes ? `${homes.length} homes, ${lines_skipped} registry lines skipped (no local home), ` : '';
  const steers = n('daily') ? records.filter((r) => r.data.kind === 'daily').reduce((sum, r) => sum + r.data.steers, 0) : n('steer');
  const tables = n('pr') || n('daily') ? `, ${n('pr')} merged PRs and ${n('daily')} daily rows in data/metrics` : '';
  const unparsed = chatRows && missing?.some((m) => m.includes('chat.tsv')); // rows in chat.tsv, none with text: named, not silent
  return { level: unparsed ? 'warn' : 'ok', detail: `${fleet}${n('decision')} decisions, ${n('block')} blocks, ${steers} steers, ${n('defect')} defect records${n('complaint') ? `, ${n('complaint')} captain complaints` : ''}${tables}, ${skipped} skipped (no time)${unparsed ? `; chat.tsv has ${chatRows} rows and none parsed into text (header at<TAB>work<TAB>text, tab-separated)` : ''}` };
}

// The hours the tasks spent in each stage in the window, by the day the stage began, and the tasks timed; n/a with no timed
// stage. The hours a merged PR stayed open (prs.tsv) give the merge wait when the home keeps that table, else the status
// lines that wait on a merge do.
function stageHours(rows, window) {
  const kind = (k) => inWindow(rows.filter((r) => JSON.parse(r.data).kind === k), window).map((r) => JSON.parse(r.data));
  const stages = kind('stage'), prs = kind('pr').filter((p) => Number.isFinite(p.hours));
  const sum = (name) => stages.filter((x) => x.stage === name).reduce((n, x) => n + x.hours, 0);
  if (!stages.length) return Object.fromEntries(STAGE_METRICS.map((m) => [m, null]));
  return { [WORKING.metric]: sum('working'), ...Object.fromEntries(Object.entries(STAGES).map(([name, s]) => [s.metric, name === 'merge' && prs.length ? prs.reduce((n, p) => n + p.hours, 0) : sum(name)])),
    tasks_timed: new Set(stages.map((x) => x.task)).size };
}

// decisions, blocks and steers in the window; interventions_per_merge is their sum over the PRs merged (n/a with no
// merge). The home's dated defect records add to defects. With no github source, its prs.tsv gives the PR metrics (as the
// github source computes them) and its daily.tsv gives corrections_per_session, over the PRs merged since the home
// records no session count; a sessions source's own number wins. corrections_per_merge is the same corrections over the PRs
// merged, whichever source counts the merges.
export const metricNames = ['decisions', 'blocks', 'steers', 'interventions_per_merge', 'merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge',
  'rework_ci', 'rework_other', 'rework_per_merge', 'reverted', 'escaped', 'corrections_per_session', 'corrections_per_merge', ...STAGE_METRICS];
export const addsTo = ['defects']; // the follow-up step reads this source's records for these metrics too
export const metricRows = 'records';
export function metrics(rows, window, v) {
  const of = (kind) => inWindow(rows.filter((r) => JSON.parse(r.data).kind === kind), window);
  const kept = (kind) => rows.filter((r) => JSON.parse(r.data).kind === kind);
  const out = { decisions: of('decision').length, blocks: of('block').length, steers: steersIn(rows, window) };
  const prs = v.merged == null && kept('pr').length ? github.metrics(kept('pr'), window) : {}, merged = v.merged ?? prs.merged;
  const corrections = merged && kept('daily').length ? of('daily').reduce((n, r) => n + JSON.parse(r.data).corrections, 0) / merged : undefined;
  const isDefect = (r) => ['defect', 'complaint'].includes(JSON.parse(r.data).kind), defects = rows.filter((r) => r.ts && isDefect(r));
  return { ...prs, ...out, ...stageHours(rows, window), ...(corrections !== undefined && { corrections_per_merge: corrections, ...(v.corrections_per_session == null && { corrections_per_session: corrections }) }),
    interventions_per_merge: merged ? (out.decisions + out.blocks + out.steers) / merged : null,
    ...(defects.length && { defects: (v.defects ?? 0) + inWindow(rows.filter(isDefect), window).length }) };
}
