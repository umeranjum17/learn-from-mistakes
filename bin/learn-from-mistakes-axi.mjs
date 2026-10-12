#!/usr/bin/env node
// learn-from-mistakes-axi: find repeated causes in the record of past work. Sources are only read; state goes to the state dir,
// <project>/.lfm by default, which the tool git-ignores itself.
// Judgement (is this line a failure, which cause, which earlier line it repeats) comes from an agent's
// labels.jsonl; this file only parses, dedups and counts.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode as toonEncode } from '@toon-format/toon';
import { isMetric, loadConfig, loadGlobal, METRIC_RULE, PROJECT_FILE, RULE, SOURCES } from '../src/config.mjs';
import { abort, attach, logs, rerun, retro, runs, status, worker } from '../src/run.mjs';
import { doctor } from '../src/doctor.mjs';
import { init } from '../src/init.mjs';
import * as byokit from '../src/runners/byokit.mjs';
import { agents, CLASH, INSTALL, RUNNERS } from '../src/runners/index.mjs';
import { openStore } from '../src/store.mjs';

// Every rejection prints `error: <what was wrong>` and `next: <a runnable command or the allowed form>`.
export class UsageError extends Error {
  code = 2;
  constructor(message, next = 'learn-from-mistakes-axi --help   # supported commands and options') { super(message); this.next = next; }
}
export class InputError extends UsageError { code = 1; } // a line in a file the run reads is bad, not the command
export class EmptyError extends UsageError { code = 3; } // nothing to read
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function readText(file, name = file, next = undefined) {
  try { return readFileSync(file, 'utf8'); } catch (e) { throw new UsageError(`${name}: cannot read (${e.code})`, next); }
}
// A path printed inside a command the user copies: quoted unless it is only plain path characters.
export const shq = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`);

// Create the state dir before a write. The in-project default gets a `*` .gitignore whenever it has none,
// so its record text can never be committed; a file the user already has there is never overwritten.
export function stateDir(cfg) {
  try { mkdirSync(cfg.state, { recursive: true }); } catch (e) {
    throw new UsageError(`${cfg.state}: cannot create the state dir (${e.code})`, cfg.ignore
      ? 'mv <project>/.lfm <elsewhere>   # free .lfm for the state dir, or set state_root in $LFM_HOME/config.yaml'
      : 'edit state_root in $LFM_HOME/config.yaml   # a dir lfm can create and write');
  }
  if (!cfg.ignore) return;
  const file = join(cfg.state, '.gitignore');
  try { writeFileSync(file, '*\n', { flag: 'wx' }); } catch (e) {
    if (e.code !== 'EEXIST') throw new UsageError(`${file}: cannot write (${e.code})`, 'chmod u+rwx <project>/.lfm   # the tool writes .lfm/.gitignore there');
    // git reads only a regular .gitignore; a directory or symlink there would leave the state committable
    let st;
    try { st = lstatSync(file); } catch (e2) { throw new UsageError(`${file}: cannot read (${e2.code})`, 'chmod u+r <project>/.lfm/.gitignore   # the tool checks it ignores all of .lfm'); }
    if (!st.isFile()) throw new UsageError(`${file}: not a regular file, so git would not ignore the state; replace it with a file containing *`,
      'rm -r <project>/.lfm/.gitignore   # the tool then writes one that ignores all of .lfm');
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e2) { throw new UsageError(`${file}: cannot read (${e2.code})`, 'chmod u+r <project>/.lfm/.gitignore   # the tool checks it ignores all of .lfm'); }
    const lines = text.split(/\r?\n/);
    if (!lines.includes('*') || lines.some((l) => l.startsWith('!'))) throw new UsageError(`${file}: does not ignore all of .lfm, so state could be committed; make it contain the line *`,
      "echo '*' >> <project>/.lfm/.gitignore   # ignore all of .lfm, and delete any line starting with !");
  }
}

// `ingest` (a state file this tool wrote: missing or corrupt is exit 2, fixed by ingest again) or
// `rerun` (labels/proposals the caller wrote: a bad line is an input problem, exit 1).
function readJsonl(file, { ingest, rerunHint }) {
  if (!existsSync(file)) { if (ingest) throw new UsageError(`${file} missing`, ingest); return []; }
  return readText(file).split('\n').flatMap((l, i) => {
    if (!l.trim()) return [];
    try { return [{ ...JSON.parse(l), _line: i + 1 }]; } catch {
      throw ingest ? new UsageError(`${file}:${i + 1}: not valid JSON`, ingest) : new InputError(`${file}:${i + 1}: not valid JSON`, rerunHint);
    }
  });
}

// The append-only change ledger: one JSON object per line, ids/cause keys/times, the metric, tripwire and kind
// that show whether the change worked (a line written before them reads as the defaults), plus the
// optional owner-written one-line `what`/`why` that only `learn-from-mistakes-axi changes` prints.
// A missing file means zero entries, never an error. Problems name file:line only,
// never line contents, so a corrupt ledger stays privacy-bounded too. A repeated id is a
// problem: `project` + `id` is the join key other tools rely on.
export function readLedger(file) {
  if (!existsSync(file)) return { entries: [], problems: [] };
  const entries = [], problems = [], ids = new Set();
  readText(file).split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { problems.push(`${file}:${i + 1}: not valid JSON`); return; }
    const ok = e && typeof e === 'object' && !Array.isArray(e) && e.v === 1
      && typeof e.id === 'string' && e.id && typeof e.cause === 'string' && e.cause
      && typeof e.ref === 'string' && e.ref && typeof e.at === 'string' && e.at
      && [e.what, e.why].every((t) => t === undefined || (typeof t === 'string' && t === oneLine(t)))
      && (e.metric === undefined || (typeof e.metric === 'string' && storedMetric(e.metric)))
      && (e.tripwire === undefined || (typeof e.tripwire === 'string' && RULE.test(e.tripwire))) && (e.kind === undefined || KINDS.includes(e.kind));
    if (!ok) problems.push(`${file}:${i + 1}: not a valid change entry`);
    else if (ids.has(e.id)) problems.push(`${file}:${i + 1}: repeats change id ${shown(e.id)}`);
    else { ids.add(e.id); entries.push(e); }
  });
  return { entries, problems };
}
// `change applied` and `changes` refuse a ledger with problems; the report only counts them.
function cleanLedger(file, opts) {
  const { entries, problems } = readLedger(file);
  if (problems.length) throw new InputError(problems.join('\nerror: '), withContext('learn-from-mistakes-axi changes', 'check the ledger again after fixing those lines', opts));
  return entries;
}

const REF_RE = /^(?:[0-9a-f]{7,40}|sha256:[0-9a-f]{64})$/;
const KINDS = ['doc', 'rule', 'code']; // what the change edited; the first is the default
// The ledger fields that show whether a change worked, with the defaults for a line that has none.
const measure = (e) => ({ metric: e.metric ?? `cause_count:${e.cause}`, tripwire: e.tripwire ?? '', kind: e.kind ?? KINDS[0] });
const UNPRINTABLE = /[\p{Cc}\u2028\u2029]/u;
// A value the user typed, safe to echo: quoted, or a placeholder when long or not printable.
const shown = (v) => ([...v].length > 80 || UNPRINTABLE.test(v) ? '(invalid value)' : JSON.stringify(v));
// Owner text for --what/--why: trimmed, 1-200 characters, no line breaks or control characters. A stored metric
// allows a tab, since a cause key may hold one and the default metric is built from it.
function oneLine(text, { allowTab = false } = {}) {
  const t = text.trim();
  return [...t].length >= 1 && [...t].length <= 200 && !UNPRINTABLE.test(allowTab ? t.replaceAll('\t', '') : t) ? t : undefined;
}
const storedMetric = (m) => oneLine(m, { allowTab: true }) !== undefined;

// ponytail: single-writer ledger. The id is the highest chg-<n> + 1 and the write is one
// O_APPEND call, so a lone writer can never interleave or repeat an id (a hand-deleted last
// line is the one way to reuse one). Concurrent writers could read the same ledger and
// repeat an id; a lock file is the upgrade.
function recordChange(cfg, opts, json) {
  const form = FORMS['change-applied'];
  for (const k of ['cause', 'ref']) if (opts[k] === undefined) throw new UsageError(`change applied needs --${k}`, form);
  const known = Object.keys(cfg.causes).filter((c) => c !== 'other');
  if (!known.includes(opts.cause)) {
    const list = `known: ${known.join(', ') || `none, add causes to ${PROJECT_FILE}`}`;
    throw new UsageError(opts.cause === 'other' ? `cause "other" is reserved and never recordable (${list})` : `unknown cause ${shown(opts.cause)} (${list}; "other" is reserved)`, form);
  }
  if (!REF_RE.test(opts.ref)) throw new UsageError(`--ref ${shown(opts.ref)} must be a 7-40 lowercase hex commit or sha256:<64 lowercase hex>`, 'git rev-parse HEAD   # a commit id to pass as --ref');
  let at;
  if (opts.at === undefined) at = new Date().toISOString();
  else {
    const ms = Date.parse(opts.at);
    if (Number.isNaN(ms)) throw new UsageError(`--at ${shown(opts.at)} must be an ISO 8601 time`, withContext(`learn-from-mistakes-axi change applied --cause ${opts.cause} --ref ${opts.ref} --at 2026-10-12T09:00:00Z`, 'or leave --at out for now', opts));
    at = new Date(ms).toISOString();
  }
  if (opts.metric !== undefined && !isMetric(opts.metric, cfg.causes)) throw new UsageError(`--metric ${shown(opts.metric)} must be ${METRIC_RULE}`, form);
  const trip = opts.tripwire === undefined ? undefined : RULE.exec(opts.tripwire.trim());
  if (opts.tripwire !== undefined && !trip) throw new UsageError(`--tripwire ${shown(opts.tripwire)} must be "<op> <number>" with op >=, <=, >, < or =, such as "<= 0"`, form);
  if (opts.kind !== undefined && !KINDS.includes(opts.kind)) throw new UsageError(`--kind ${shown(opts.kind)} must be doc, rule or code`, form);
  const text = {};
  for (const k of ['what', 'why']) {
    if (opts[k] !== undefined && (text[k] = oneLine(opts[k])) === undefined) throw new UsageError(`--${k} ${shown(opts[k])} must be one line of 1-200 characters, with no line breaks or control characters`, form);
  }
  const file = join(cfg.state, 'changes.jsonl');
  const entries = cleanLedger(file, opts);
  const n = Math.max(0, ...entries.map((e) => Number(/^chg-(\d+)$/.exec(e.id)?.[1] ?? 0))) + 1;
  const { metric, kind } = measure({ cause: opts.cause, metric: opts.metric, kind: opts.kind });
  if (!storedMetric(metric)) throw new UsageError(`metric ${shown(metric)} must be one line of 1-200 characters, with no control characters or line separators`, form);
  const entry = { v: 1, id: `chg-${n}`, cause: opts.cause, ref: opts.ref, at, metric,
    ...(trip && { tripwire: `${trip[1]} ${trip[2]}` }), kind };
  stateDir(cfg);
  appendFileSync(file, JSON.stringify({ ...entry, ...text }) + '\n');
  console.log(render(entry, json)); // what/why leave only through `learn-from-mistakes-axi changes`
  hint(withContext('learn-from-mistakes-axi report', 'the report with the ledger', opts));
}

// lfm-changes.v1: every applied change in ledger order. The join key is `project` + `id`.
function exportChanges(cfg, opts, json) {
  const changes = cleanLedger(join(cfg.state, 'changes.jsonl'), opts).map((e) => ({ id: e.id, cause: e.cause, ref: e.ref, at: e.at, ...measure(e), what: e.what ?? '', why: e.why ?? '' }));
  console.log(render({ schema: 'lfm-changes.v1', generated_at: new Date().toISOString(), project: cfg.name, changes }, json));
  if (!changes.length) hint(withContext('learn-from-mistakes-axi change applied --cause <cause> --ref <ref> --what <text> --why <text>', 'record a change you already made', opts));
  else hint(json ? withContext('learn-from-mistakes-axi report', 'the per-cause counts', opts) : withContext('learn-from-mistakes-axi changes --json', 'the same export as JSON', opts));
}

function readInput(file, flag, explicit, rerunHint) {
  if (explicit && !existsSync(file)) throw new UsageError(`--${flag} ${file}: no such file`, `--${flag} <an existing ${flag}.jsonl>   # or leave --${flag} out to read the state dir`);
  return readJsonl(file, { rerunHint });
}

export const sourceLine = (s, hash = true) => `${s.id.padEnd(12)} ${s.type.padEnd(13)} ${String(s.items).padStart(5)} items${hash ? `  sha256 ${s.hash.slice(0, 12)}` : ''}`;

// Reads every configured source into the state dir. Returns each source's id, type, item count and hash (plus the
// session counts of a sessions source), the items read, the start of this window and the last, and of the read range.
// The sessions the tool's own runs started (the run store's `invocations` table, when there is one) are skipped.
export async function ingest(cfg) {
  stateDir(cfg);
  const db = await openStore(cfg.state, false);
  const skip = new Set(db?.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'invocations'`).get()
    ? db.prepare('SELECT session_id FROM invocations WHERE session_id IS NOT NULL').all().map((r) => r.session_id) : []);
  db?.close();
  // This window and the last, and far enough back to have before-numbers for every applied change.
  const w = parseInt(cfg.window, 10) * 86_400_000, since = Date.now() - w, iso = (ms) => new Date(ms).toISOString();
  const readFrom = Math.min(since - w, ...readLedger(join(cfg.state, 'changes.jsonl')).entries.map((c) => Date.parse(c.at) - w).filter(Number.isFinite));
  const records = [], rows = [], events = [], prs = [], sources = [];
  for (const [id, s] of Object.entries(cfg.sources)) {
    const got = await SOURCES[s.type].read(id, s, { readFrom, excerpts: cfg.excerpts === 'on', skip, causes: cfg.causes });
    records.push(...(got.records ?? []));
    rows.push(...(got.rows ?? []));
    events.push(...(got.events ?? []));
    prs.push(...(got.prs ?? []));
    sources.push({ id, type: s.type, items: (got.records ?? got.rows ?? got.events ?? got.prs).length, hash: got.hash,
      ...(got.events && { sessions: got.sessions, skipped: got.skipped }) });
  }
  const jsonl = (a) => a.map((x) => JSON.stringify(x)).join('\n') + (a.length ? '\n' : '');
  writeFileSync(join(cfg.state, 'records.jsonl'), jsonl(records));
  writeFileSync(join(cfg.state, 'rows.jsonl'), jsonl(rows));
  writeFileSync(join(cfg.state, 'sources.json'), JSON.stringify({ read_at: new Date().toISOString(), sources }, null, 1));
  return { sources, events, records, rows, prs, read_from: iso(readFrom), current_start: iso(since), previous_start: iso(since - w) };
}

function analyse(cfg, files, rerunHint) {
  const reingest = withContext('learn-from-mistakes-axi ingest', 'read the configured sources into the state dir', files);
  const records = new Map(readJsonl(join(cfg.state, 'records.jsonl'), { ingest: reingest }).map((r) => [r.id, r]));
  const rows = readJsonl(join(cfg.state, 'rows.jsonl'), { ingest: reingest });
  const metaFile = join(cfg.state, 'sources.json');
  if (!existsSync(metaFile)) throw new UsageError(`${metaFile} missing`, reingest);
  let meta;
  try { meta = JSON.parse(readText(metaFile)); } catch (e) { if (e instanceof UsageError) throw e; throw new UsageError(`${metaFile}: not valid JSON`, reingest); }
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.sources)) throw new UsageError(`${metaFile}: not valid sources state`, reingest);
  const problems = [];
  const { entries: changes, problems: ledgerProblems } = readLedger(join(cfg.state, 'changes.jsonl'));
  problems.push(...ledgerProblems);
  const labels = new Map();
  const lf = files.labels ?? join(cfg.state, 'labels.jsonl'), pf = files.proposals ?? join(cfg.state, 'proposals.jsonl');
  // Problem lines name file:line and the rule broken, never a record id (a hash of private
  // text) or a ref; a cause is echoed only through `shown`.
  for (const l of readInput(lf, 'labels', files.labels, rerunHint)) {
    const at = `${basename(lf)}:${l._line}`;
    if (!records.has(l.id)) problems.push(`${at}: unknown record id (its record text changed or it was never ingested)`);
    else if (labels.has(l.id)) problems.push(`${at}: second label for the record labelled at line ${labels.get(l.id)._line}`);
    else if (typeof l.event !== 'boolean' || typeof l.why !== 'string' || !l.why.trim()) problems.push(`${at}: needs event (true/false) and why`);
    else if (l.event && (typeof l.cause !== 'string' || (!Object.hasOwn(cfg.causes, l.cause) && l.cause !== 'other'))) problems.push(`${at}: cause ${typeof l.cause === 'string' ? shown(l.cause) : 'that is not a string'} is not in the config`);
    else if (l.duplicate_of !== undefined && !records.has(l.duplicate_of)) problems.push(`${at}: duplicate_of names an unknown record`);
    else if (l.occurrences !== undefined && !(Number.isInteger(l.occurrences) && l.occurrences > 0)) problems.push(`${at}: occurrences must be a positive integer`);
    else labels.set(l.id, l);
  }
  // A duplicate collapses into the record it repeats; that root is one incident, or `occurrences` of them.
  const root = (id, seen = new Set()) => {
    const d = labels.get(id)?.duplicate_of;
    return !d || seen.has(id) || labels.get(d)?.cause !== labels.get(id).cause || !labels.get(d).event ? id : root(d, seen.add(id));
  };
  const groups = Object.create(null);
  const group = (cause) => (groups[cause] ??= { cause, description: cfg.causes[cause]?.description ?? 'Events no listed cause names.',
    log: { roots: new Map(), records: [], days: new Set() }, store: { rows: [], days: new Set() } });
  for (const l of labels.values()) {
    if (!l.event) continue;
    const g = group(l.cause).log, r = records.get(l.id), k = root(l.id);
    g.roots.set(k, labels.get(k).occurrences ?? 1);
    g.records.push({ ...r, label: l });
    if (r.date) g.days.add(r.date);
  }
  for (const [cause, c] of Object.entries(cfg.causes)) {
    if (!c.match) continue;
    for (const row of rows) if (row.cause === cause) {
      group(cause).store.rows.push(row);
      if (row.at) group(cause).store.days.add(row.at.slice(0, 10));
    }
  }
  const { min_incidents: mi, min_days: md } = cfg.repeat;
  const list = Object.values(groups).map((g) => {
    const incidents = [...g.log.roots.values()].reduce((a, b) => a + b, 0);
    const logRepeated = incidents >= mi && g.log.days.size >= md, storeRepeated = g.store.rows.length >= mi && g.store.days.size >= md;
    return { ...g, incidents, repeated: g.cause !== 'other' && (logRepeated || storeRepeated), by: [logRepeated && 'log', storeRepeated && 'store'].filter(Boolean) };
  }).sort((a, b) => b.repeated - a.repeated || Math.max(b.incidents, b.store.rows.length) - Math.max(a.incidents, a.store.rows.length));
  const repeatedByCause = new Map(list.map((g) => [g.cause, g.repeated]));
  const proposals = readInput(pf, 'proposals', files.proposals, rerunHint).map((p, index) => {
    const refs = Array.isArray(p.refs) ? p.refs : [];
    const resolves = (ref) => records.has(ref) || rows.some((r) => `${r.source}:${r.id}` === ref);
    const missing = refs.filter((ref) => !resolves(ref));
    const bad = typeof p.cause !== 'string' || !groups[p.cause] ? `cause ${typeof p.cause === 'string' ? shown(p.cause) : 'that is not a string'} has no counted events`
      : !refs.length ? 'no evidence refs' : missing.length ? `${missing.length} of ${refs.length} refs not found` : !p.change ? 'no change text'
      : !repeatedByCause.get(p.cause) ? `cause ${shown(p.cause)} did not repeat; propose only for repeated causes`
      : typeof p.target !== 'string' || !p.target.trim() ? 'no target'
      : typeof p.owner !== 'string' || !p.owner.trim() ? 'no owner'
      : index >= 5 ? 'more than five proposals; keep the five strongest' : '';
    if (bad) problems.push(`${basename(pf)}:${p._line}: ${bad}`);
    return { ...p, refs: refs.filter(resolves), ok: !bad };
  });
  return { cfg, meta, records, rows, labels, groups: list, proposals, problems, unlabelled: [...records.keys()].filter((id) => !labels.has(id)).length, changes };
}

// The report model and the problems behind its count; throws when the sources hold nothing to count.
export function buildReport(cfg, files, rerunHint, full) {
  const a = analyse(cfg, files, rerunHint);
  // A sessions or github source always counts: a week with no sessions or PRs still has numbers.
  if (!a.records.size && !a.rows.length && !a.meta.sources.some((s) => s.items || ['sessions', 'github'].includes(s.type))) throw new EmptyError('no records or rows in the sources: nothing to count',
    withContext('learn-from-mistakes-axi ingest', 'read the configured sources, or fix source paths in .learn-from-mistakes.yaml', files));
  return { model: project(a, full), problems: a.problems };
}

// The one shape every machine and default output may carry: identifiers and counts only.
// Record text, label `why`, proposal `change`, cause descriptions, source paths and branches never enter it.
// `full` adds allow-listed non-content evidence ids; it is not permission to print private evidence.
function project(a, full) {
  const byCause = new Map();
  for (const c of a.changes ?? []) {
    const list = byCause.get(c.cause) ?? [];
    list.push(c);
    byCause.set(c.cause, list);
  }
  for (const cause of byCause.keys()) {
    if (a.groups.some((g) => g.cause === cause)) continue;
    a.groups.push({ cause, repeated: false, by: [], incidents: 0, log: { records: [], days: new Set() }, store: { rows: [], days: new Set() } });
  }
  const causes = a.groups.map((g) => {
    const ps = a.proposals.filter((p) => p.cause === g.cause);
    const applied = byCause.get(g.cause) ?? [];
    const m = {
      cause: g.cause,
      repeated: g.repeated,
      by: g.by,
      log: { incidents: g.incidents, records: g.log.records.length, days: g.log.days.size },
      store: { matched: Boolean(a.cfg.causes[g.cause]?.match), rows: g.store.rows.length, days: g.store.days.size },
      proposals: { count: ps.length, unchecked: ps.filter((p) => !p.ok).length },
      changes: { count: applied.length, last_at: applied.length ? applied.map((c) => c.at).sort().at(-1) : '' },
    };
    if (full) {
      m.change_ids = applied.map((c) => c.id);
      m.change_refs = [...new Set(applied.map((c) => c.ref))]; // user-supplied version ids, never private record content
      // Only non-content ids: a record id is a hash of its text, so emitting one would confirm private prose.
      m.store_row_ids = g.store.rows.map((r) => `${r.source}:${r.id}`);
      m.proposal_refs = [...new Set(ps.flatMap((p) => p.refs).filter((ref) => a.rows.some((r) => `${r.source}:${r.id}` === ref)))];
    }
    return m;
  });
  return {
    schema: 'lfm-report.v1',
    generated_at: new Date().toISOString(),
    ingested_at: a.meta.read_at ?? '',
    coverage: { labelled: a.labels.size, total_records: a.records.size, unlabelled: a.unlabelled },
    problems: a.problems.length,
    ledger: { entries: a.changes?.length ?? 0 },
    sources: a.meta.sources.map((s) => ({ id: s.id, type: s.type, items: s.items })),
    causes,
  };
}

const render = (model, json) => (json ? JSON.stringify(model, null, 2) : toonEncode(model));

// One stdout line after the TOON report, before the stderr hints: which causes
// repeated, in report order, with the same incidents/days the report shows.
// A cause repeated only through store rows says rows, never incidents.
// Identifiers and counts only, never record text.
export function summaryLine(model) {
  const parts = [];
  for (const c of model.causes) {
    if (!c.repeated) continue;
    if (c.by.includes('log')) parts.push(`${c.cause} (${c.log.incidents} incidents/${c.log.days} days)`);
    else parts.push(`${c.cause} (${c.store.rows} rows/${c.store.days} days)`);
  }
  return parts.length ? `repeated: ${parts.join(', ')}` : 'repeated: none';
}

const USAGE = `usage: learn-from-mistakes-axi [<init|doctor|guide|ingest|count|report|change applied|changes|retro|status|runs|attach|logs|abort|rerun|agents>] [options]
  (no command)        print the project's repeated-cause report (same as \`report\`)
  init                write .learn-from-mistakes.yaml if the project has none: a worker and a different judge from the
                      agent CLIs found, and the sources found; otherwise print it and its gaps. Either way, make the state dir .lfm/ and its .gitignore
  doctor              check node, git, the config, .lfm ignored, each source, the worker and judge (usable, login, model,
                      a different identity), the skill per agent CLI and sign-off: ok, warn or fail, with a fix: line; exit 1 on a fail
  guide               print the agent procedure: config, ingest, label, propose, report
  ingest              read the configured sources (read-only) into the state dir (<project>/.lfm, git-ignored)
  count               print the counts (same projection as \`report\`)
  report              print the report; --full adds evidence ids, --json prints JSON
  change applied      record an applied change in the append-only ledger
  changes             print every applied change (lfm-changes.v1) with its owner-written what/why
  retro               start a saved run in <state dir>/lfm.sqlite (ingest, then report) in a background worker
                      that goes on when this terminal ends; --wait <time> waits for it, --foreground runs it here
  status              print the last saved run and its steps
  runs                list the saved runs, newest first
  attach              print the run's step states and log lines as they come, until it ends
  logs --step <name>  print one step's log lines
  abort               stop the running run: its worker ends and the run is cancelled
  rerun               start a new run with the current config; --run <id> names the run it follows (default: the last run), and say
                      which run it started from; --resume finishes that interrupted, cancelled or failed run
                      from its first step that is not completed
  agents              list the agent CLIs the tool can start: usable, version, login presence, default model
  --dir <dir>         project dir holding .learn-from-mistakes.yaml (default: the current dir)
  --labels <file>     labels.jsonl to read (default: the state dir)
  --proposals <file>  proposals.jsonl to read (default: the state dir)
  --cause <cause>     (change applied) cause key from the config, never \`other\`
  --ref <ref>         (change applied) version id: git sha (7-40 hex) or sha256:<64 hex>
  --metric <metric>   (change applied) the metric that shows whether it worked (default: cause_count:<cause>)
  --tripwire <rule>   (change applied) the value that metric must reach, "<op> <number>" such as "<= 0" (default: none)
  --kind <kind>       (change applied) what the change edited: doc, rule or code (default: doc)
  --at <time>         (change applied) time of the change, ISO-8601 (default: now)
  --what <text>       (change applied) what changed: one line, 1-200 characters, printed only by \`changes\`
  --why <text>        (change applied) why it changed: one line, 1-200 characters, printed only by \`changes\`
  --run <id>          (status, attach, logs, abort, rerun) the saved run (default: the last one; abort: the running one)
  --step <name>       (logs) the step: collect or report
  --wait [<time>]     (retro, rerun) wait up to 30s, 8m or 1h (default 8m) for the run to end, then print it
  --live              (doctor) also make one live call per role, as agents --test (costs tokens)
  --test <runner>     (agents) one live call to that agent CLI, acp:<target> through acpx, or byokit:<route> through BYOKit (costs tokens): it must answer and write no file
  --worker <runner>   (init) the agent CLI that does the work (default: the first usable one)
  --judge <runner>    (init) the agent CLI that checks it (default: the first usable one that differs from the worker)
  --no-excerpts       (init) write excerpts: off, so the agents get pointers and counts only, never record text
  --no-skill, -y      (init) accepted for scripts: init installs no skill and asks nothing
  --json (init, doctor, report, count, change applied, changes, retro, status, runs, attach, logs, abort, rerun, agents)  print JSON instead of the default TOON (report, count: lfm-report.v1; changes: lfm-changes.v1)
  --full (report, count)  add allow-listed evidence ids (never record text)
  -h, --help          show this help and the supported commands
  -v, --version       show the version
the report is privacy-bounded: identifiers and counts only, never record text, label/proposal prose or change what/why;
\`changes\` prints only the what/why you wrote with \`change applied\``;
const HELP = `${USAGE}

next: learn-from-mistakes-axi init           # write the config for the project you are in
next: learn-from-mistakes-axi doctor         # what is wrong, and the fix for each
next: learn-from-mistakes-axi guide          # the procedure an agent follows to label and report
next: learn-from-mistakes-axi                # the report for the project you are in
next: learn-from-mistakes-axi --dir <project>   # point at a project with .learn-from-mistakes.yaml
next: learn-from-mistakes-axi report --full  # add the evidence ids
next: learn-from-mistakes-axi change applied --cause <cause> --ref <ref> --what <text> --why <text>   # record a change you already made
next: learn-from-mistakes-axi changes --json    # every applied change with its id, version, date, what and why
next: learn-from-mistakes-axi retro --wait 8m   # ingest and report as a saved run, then status and runs show it
next: learn-from-mistakes-axi agents          # the agent CLIs the tool can start and their default models`;
// The agent procedure lives here, not in the installed skill, so a skill copy never goes stale.
// The model line only tells the agent which session model to use; the cheap defaults live in src/models.json.
const lfmModel = () => (process.env.LFM_MODEL ?? '').trim();
const guideText = () => `learn-from-mistakes-axi guide: you judge each record, the CLI counts. Never edit the sources,
AGENTS.md, CLAUDE.md or skills; your output is recommendations only.

Model: do this work on ${lfmModel() ? `${lfmModel()} (LFM_MODEL)` : 'the cheap default of the agent CLI that runs it'}. learn-from-mistakes-axi agents
lists each agent CLI's default. Never take Opus, Sonnet or Sol as the default. LFM_MODEL or worker.model overrides it; with
worker.runner auto, the model must be one an agent CLI lists as its default, else set worker.runner to the CLI that runs it.

1. Config. No .learn-from-mistakes.yaml in the project? Write one (it is this tool's own file):
     name: <project>
     sources:
       log: { type: markdown-log, path: defects.md }   # each top-level "- " bullet is a record; a YYYY-MM-DD in it dates it, else its "## YYYY-MM-DD" heading
       # gate: { type: no-mistakes, path: ~/.no-mistakes/state.sqlite }   # optional: no-mistakes store, failed steps read-only
     causes:
       <cause-id>:
         description: "<the mechanism, one sentence>"   # quote it: commas and colons are fine inside quotes
     repeat: { min_incidents: 3, min_days: 2 }
   A cause is a mechanism, not a keyword. Add causes once you have read the records.
   Optional per cause: match: { source: gate, error_contains: "<error text>" } counts store rows, or
   match: { source: <sessions id>, signal, tool, text_contains } counts session events.

2. Ingest: learn-from-mistakes-axi ingest
   It prints the state dir. records.jsonl there: one JSON object per bullet (id, source, line, date, text).

3. Label every record you read into labels.jsonl in the state dir, one line each:
     {"id":"<record id>","event":true,"cause":"<cause id from the config, or other>","why":"<25 words or fewer>"}
   Optional: "duplicate_of":"<earlier record id>", "occurrences":<n separate dated incidents>, "confidence":"medium".
   - event:true only when something went wrong. Fix notes, rules, status, plans: event:false, cause not-an-event.
   - A consequence of an incident is not a repeat of it. A shared keyword is not a shared cause.
   - Same incident logged twice: the later record gets duplicate_of the earlier one; it counts once.
   - A real failure no cause names is other (never counted as repeated); say the mechanism in why.
   - No causes in the config, or several other labels share one mechanism? Add a cause (key + description) to
     .learn-from-mistakes.yaml, or give the user that causes: snippet if they own the config, then relabel.
   - Label only what you read. Unlabelled records are reported as not analysed; never guess to fill coverage.

4. Count: learn-from-mistakes-axi count
   A cause repeats when one source shows min_incidents incidents on min_days days. Log and store are never added.

5. Propose a change for each repeated cause in proposals.jsonl in the state dir, at most five lines:
     {"cause":"<cause id>","target":"<file, script, config or tool>","owner":"<who>","change":"<one sentence>","refs":["<record id>","<source>:<row id>"]}
   Prefer a check, a script or a deleted rule over more prose. Every ref must be a record id or source:row id.

6. Report: learn-from-mistakes-axi report   (exit 1: fix the counted label/proposal problems and rerun)
   The output holds ids and counts only. Tell the user each repeated cause with its description, its counts
   and your proposals from proposals.jsonl.

7. Once a change is made: learn-from-mistakes-axi change applied --cause <cause> --ref <git sha | sha256:<64 hex>>
     --metric <metric> --tripwire "<op> <number>" --kind doc|rule|code   # optional: recorded with the change; a later retro step checks it
     --what "<what changed>" --why "<why>"   # optional, one line each; never record text or label prose
   learn-from-mistakes-axi changes lists them (lfm-changes.v1); the report shows only counts and dates.

next: learn-from-mistakes-axi ingest   # after step 1`;

function hint(text) { if (text) console.error(`next: ${text}`); }
const INPUT_FLAGS = ['dir', 'labels', 'proposals'];
export const withContext = (base, note, opts) => {
  const flags = INPUT_FLAGS.filter((k) => opts[k]).map((k) => `--${k}`);
  return flags.length ? `${base}   # ${note} (keep your ${flags.join(' ')})` : `${base}   # ${note}`;
};
const NEXT = (json, full, opts) => {
  if (full && json) return '';
  const detail = full || json ? '--full --json' : '--full';
  return withContext(`learn-from-mistakes-axi report ${detail}`, full ? 'the same report as JSON' : 'add the evidence ids', opts);
};
const LABEL_STEP = (cfg, opts) => `label ${join(cfg.state, 'records.jsonl')} into labels.jsonl in the same dir (see learn-from-mistakes-axi guide), then ${withContext('learn-from-mistakes-axi count', 'the counts', opts)}`;
// The allowed form of each command; the flags it takes are read from it.
const FORMS = {
  init: 'learn-from-mistakes-axi init [--worker <runner>] [--judge <runner>] [--no-excerpts] [--no-skill] [-y] [--dir <dir>] [--json]',
  doctor: 'learn-from-mistakes-axi doctor [--live] [--dir <dir>] [--json]',
  guide: 'learn-from-mistakes-axi guide',
  ingest: 'learn-from-mistakes-axi ingest [--dir <dir>]',
  count: 'learn-from-mistakes-axi count [--dir <dir>] [--labels <file>] [--proposals <file>] [--json] [--full]',
  report: 'learn-from-mistakes-axi report [--dir <dir>] [--labels <file>] [--proposals <file>] [--json] [--full]',
  'change-applied': 'learn-from-mistakes-axi change applied --cause <cause> --ref <ref> [--metric <metric>] [--tripwire "<op> <number>"] [--kind doc|rule|code] [--at <time>] [--what <text>] [--why <text>] [--json] [--dir <dir>]',
  changes: 'learn-from-mistakes-axi changes [--dir <dir>] [--json]',
  retro: 'learn-from-mistakes-axi retro [--wait [<time>] | --foreground] [--dir <dir>] [--json]',
  status: 'learn-from-mistakes-axi status [--run <id>] [--dir <dir>] [--json]',
  runs: 'learn-from-mistakes-axi runs [--dir <dir>] [--json]',
  attach: 'learn-from-mistakes-axi attach [--run <id>] [--dir <dir>] [--json]',
  logs: 'learn-from-mistakes-axi logs --step <name> [--run <id>] [--dir <dir>] [--json]',
  abort: 'learn-from-mistakes-axi abort [--run <id>] [--dir <dir>] [--json]',
  rerun: 'learn-from-mistakes-axi rerun [--resume] [--run <id>] [--wait [<time>]] [--dir <dir>] [--json]',
  agents: 'learn-from-mistakes-axi agents [--test <runner>] [--dir <dir>] [--json]',
};
const JUDGE_FIX = `set judge.runner and judge.model in ${PROJECT_FILE} to an agent CLI and a different model, or install a second agent CLI`;
const AGENTS_FIX = 'learn-from-mistakes-axi agents   # the agent CLIs found, and why one is not usable';
const INSTALL_FIX = `install ${INSTALL}, or set runner_path in $LFM_HOME/config.yaml   # then run agents again`;
const VALUE_FLAGS = ['--dir', '--labels', '--proposals', '--cause', '--ref', '--metric', '--tripwire', '--kind', '--at', '--what', '--why', '--run', '--wait', '--step', '--test', '--worker', '--judge'];
const SWITCHES = ['--live', '--json', '--full', '--foreground', '--resume', '--no-excerpts', '--no-skill', '-y'];
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const PROBLEM_LINES = 20;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(HELP); return; }
  if (argv.includes('-v') || argv.includes('--version')) { console.log(VERSION); return; }
  let cmd = 'report'; // no command, or a leading flag, runs the main report job
  const named = argv[0] !== undefined && !argv[0].startsWith('-');
  if (named) cmd = argv.shift();
  if (cmd === 'change') {
    if (argv[0] !== 'applied') throw new UsageError('"change" must be followed by "applied"', FORMS['change-applied']);
    argv.shift();
    cmd = 'change-applied';
  }
  if (cmd === '_work') { await worker(loadConfig(argv[3]), Number(argv[0]), Number(argv[1])); return; } // hidden: `_work <id> <owner pid> --dir <dir>`, the worker retro spawns
  if (!Object.hasOwn(FORMS, cmd)) throw new UsageError(`unknown command ${shown(cmd)} (commands: init, doctor, guide, ingest, count, report, change applied, changes, retro, status, runs, attach, logs, abort, rerun, agents)`);
  const name = cmd.replace('-', ' '), form = FORMS[cmd];
  const next = named ? form : undefined; // a bare `learn-from-mistakes-axi --bogus` points at --help
  const opts = {};
  for (let i = 0; i < argv.length;) {
    const flag = argv[i];
    if (!flag.startsWith('-')) throw new UsageError(`unexpected argument ${shown(flag)}`, next);
    if (!VALUE_FLAGS.includes(flag) && !SWITCHES.includes(flag)) throw new UsageError(`unknown option ${shown(flag)}`, next);
    if (!form.includes(`${flag} `) && !form.includes(`${flag}]`)) throw new UsageError(`${name} does not take ${flag}`, next);
    if (SWITCHES.includes(flag)) { opts[flag.replace(/^--?/, '')] = true; i += 1; continue; }
    if (flag === '--wait' && !/^[^-]/.test(argv[i + 1] ?? '')) { opts.wait = '8m'; i += 1; continue; } // a bare --wait waits 8 minutes
    if (argv[i + 1] === undefined) throw new UsageError(`${flag} needs a value`, next ?? form);
    if (['--dir', '--labels', '--proposals'].includes(flag)) {
      // Paths are echoed whole in later errors so the user can find the file; a control character never is.
      if (UNPRINTABLE.test(argv[i + 1])) throw new UsageError(`${flag} (invalid value): a path must not contain control characters`, next ?? form);
      opts[flag.slice(2)] = resolve(argv[i + 1]);
    } else opts[flag.slice(2)] = argv[i + 1];
    i += 2;
  }
  const { json, full } = opts;
  if (cmd === 'guide') { console.log(guideText()); return; }
  for (const [k, re, rule] of [['run', /^[1-9]\d{0,8}$/, 'a run id that runs lists'], ['wait', /^[1-9]\d{0,3}[smh]$/, 'a time like 30s, 8m or 1h'], ['step', /^[a-z]{1,32}$/, 'a step name such as collect or report']]) {
    if (opts[k] !== undefined && !re.test(opts[k])) throw new UsageError(`--${k} ${shown(opts[k])} must be ${rule}`, form);
  }
  if (opts.wait) opts.wait = parseInt(opts.wait, 10) * UNIT_MS[opts.wait.at(-1)];
  if (opts.wait && opts.foreground) throw new UsageError('pass --wait or --foreground, not both', form);
  if (cmd === 'logs' && !opts.step) throw new UsageError('logs needs --step', form);
  // An acp target or a byokit route names the run dir, so it is a plain name: no path, no leading dot.
  for (const k of ['test', 'worker', 'judge']) {
    if (opts[k] !== undefined && !/^(acp|byokit):[a-z0-9][\w.-]*$/.test(opts[k]) && (opts[k] === 'acp' || !Object.hasOwn(RUNNERS, opts[k].replace(/^acp:[a-z0-9][\w.-]*$/, 'acp')))) {
      const list = Object.keys(RUNNERS).filter((r) => r !== 'acp').join(', ');
      throw new UsageError(`--${k} ${shown(opts[k])} must be a runner: ${k === 'test' ? `${list}, acp:<target> or byokit:<route>` : `${list} or acp:<target>`}`, form);
    }
  }
  if (cmd === 'agents') { await agentsCommand(opts); return; }
  if (cmd === 'init') { await initCommand(opts); return; }
  if (cmd === 'doctor') { await doctorCommand(opts); return; }
  const cfg = loadConfig(opts.dir ?? resolve('.'));
  if (cmd === 'ingest') {
    for (const s of (await ingest(cfg)).sources) console.log(sourceLine(s));
    console.log(`state: ${cfg.state}\nnext: ${LABEL_STEP(cfg, opts)}`);
    if (!Object.keys(cfg.causes).some((c) => c !== 'other')) hint('no causes configured: every label will be other; ask your agent to propose causes');
    hint(withContext('learn-from-mistakes-axi', 'the report for this project', opts));
    return;
  }
  if (cmd === 'change-applied') { recordChange(cfg, opts, json); return; }
  if (cmd === 'changes') { exportChanges(cfg, opts, json); return; }
  if (['retro', 'status', 'runs', 'attach', 'logs', 'abort', 'rerun'].includes(cmd)) { await runCommand(cmd, cfg, opts); return; }
  const rerunHint = withContext(`learn-from-mistakes-axi ${cmd}${full ? ' --full' : ''}${json ? ' --json' : ''}`, 'run again after fixing', opts);
  const { model, problems } = buildReport(cfg, opts, rerunHint, full);
  console.log(render(model, json));
  if (!json) console.log(summaryLine(model));
  if (problems.length) {
    for (const p of problems.slice(0, PROBLEM_LINES)) console.error(`problem: ${p}`);
    if (problems.length > PROBLEM_LINES) console.error(`problem: ... and ${problems.length - PROBLEM_LINES} more`);
    console.error(`problems: ${problems.length}   # fix the inputs or the change ledger`);
    hint(rerunHint);
    process.exitCode = 1;
    return;
  }
  hint(model.coverage.total_records && !model.coverage.labelled ? LABEL_STEP(cfg, opts) : NEXT(json, full, opts));
}

// The run commands open the run store, and init may read a no-mistakes store. node:sqlite warns it is experimental on Node 22, so these
// commands drop that one warning; every other warning still prints.
function quietSqlite() {
  const print = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') for (const f of print) f(w); });
}
async function runCommand(cmd, cfg, opts) {
  quietSqlite();
  const file = join(cfg.state, 'lfm.sqlite');
  let out;
  try {
    out = await { retro, status, runs, attach, logs, abort, rerun }[cmd](cfg, opts);
  } catch (e) {
    if (e.code !== 'ERR_SQLITE_ERROR') throw e;
    if (e.message.includes('UNIQUE constraint failed: runs.status')) throw new UsageError('a run is already running', withContext('learn-from-mistakes-axi runs', 'the running run', opts));
    throw new UsageError(`${file}: not a usable run store (${e.message})`, `mv ${file} <elsewhere>   # if it is not a run store; the next retro starts a new one`);
  }
  console.log(render(out, opts.json));
  if (cmd === 'rerun' && out.from != null) console.error(`rerun: started run ${out.run.id} from run ${out.from}`);
  if (cmd === 'runs') hint(out.runs.length ? withContext(`learn-from-mistakes-axi status --run ${out.runs[0].id}`, 'the steps of the last run', opts)
    : withContext('learn-from-mistakes-axi retro --wait 8m', 'ingest and report as a saved run', opts));
  else if (cmd === 'logs') hint(withContext(`learn-from-mistakes-axi status --run ${out.run}`, 'the run and all its steps', opts));
  else if (out.run.status === 'running') hint(withContext(`learn-from-mistakes-axi attach --run ${out.run.id}`, `${opts.wait ? 'still running; ' : ''}follow its steps while the run goes on in the background`, opts));
  else if (cmd === 'abort') hint(withContext(`learn-from-mistakes-axi rerun --resume --run ${out.run.id}`, 'finish it from its first step that is not completed', opts));
  else if (out.run.status === 'failed') {
    console.error(`error: ${out.run.error}`);
    const step = out.steps.find((s) => s.status === 'failed')?.name;
    hint(withContext(`learn-from-mistakes-axi rerun --resume --run ${out.run.id}`, `finish it after fixing ${step ? `the ${step} step` : 'the cause'}; completed steps are not run again`, opts));
    if (cmd !== 'status') process.exitCode = 1;
  } else if (out.run.status !== 'completed') { // interrupted or cancelled
    console.error(`error: ${out.run.error}`);
    const log = join(cfg.state, 'runs', String(out.run.id), 'worker.log');
    const output = existsSync(log) ? `; the worker's output: ${log}` : '';
    hint(withContext(`learn-from-mistakes-axi rerun --resume --run ${out.run.id}`, `finish it without running the completed steps again${output}`, opts));
    if (cmd !== 'status') process.exitCode = 1;
  } else hint(withContext('learn-from-mistakes-axi report', 'the counts this run read', opts));
}

// `agents` lists anywhere (the global config's runner_path applies); with a project config it adds the resolved worker
// and judge, and a clash between them exits 1. `--test` writes in the project's state dir, so it needs the config.
async function agentsCommand(opts) {
  const dir = opts.dir ?? resolve('.');
  const out = await agents(opts.test || existsSync(join(dir, PROJECT_FILE)) ? loadConfig(dir) : loadGlobal(), opts);
  console.log(render(out, opts.json));
  if (out.test) { hint(withContext('learn-from-mistakes-axi agents', out.test.offered ? 'every agent CLI and the resolved worker and judge' : `why ${out.test.runner} is not offered as worker or judge`, opts)); return; }
  const roles = ['worker', 'judge'].filter((r) => out[r]?.problem);
  for (const r of roles) console.error(`problem: ${r}: ${out[r].problem}`);
  if (roles.length) process.exitCode = 1;
  const pick = (!out.worker?.problem && out.worker?.runner) || (out.agents.find((a) => a.usable && !a.problem) ?? out.agents.find((a) => a.usable))?.runner;
  const next = pick?.replace(/^acp$/, 'acp:<target>');
  const bk = byokit.problem();
  const readyRoutes = async () => (await byokit.readyRoutes()).map((r) => `byokit:${r}`).join(', ');
  if (!next && !bk) hint(`set worker.runner and judge.runner in ${PROJECT_FILE} to byokit:<route>; ready: ${await readyRoutes()}`);
  else if (!next) hint(`install an agent CLI, set runner_path in $LFM_HOME/config.yaml, or for byokit:<route>: ${bk.fix}   # then run agents again`);
  else if (roles.includes('worker')) hint(`set worker.runner in ${PROJECT_FILE} to a usable agent CLI or byokit:<route>, or use a model one agent CLI lists`);
  else if (roles.includes('judge') && out.judge.problem === CLASH) hint(JUDGE_FIX);
  else if (roles.includes('judge')) hint(`install an agent CLI, or set judge.runner in ${PROJECT_FILE} to byokit:<route>; ${bk ? bk.fix : `ready: ${await readyRoutes()}`}`);
  else hint(withContext(`learn-from-mistakes-axi agents --test ${next}`, 'one live call (costs tokens): the agent must answer and write no file', opts));
}

// `doctor` prints one line per check and an indented fix: line under each one that is not ok; any fail exits 1.
async function doctorCommand(opts) {
  quietSqlite();
  const checks = await doctor(opts.dir ?? resolve('.'), opts);
  const fails = checks.filter((c) => c.level === 'fail').length;
  if (opts.json) console.log(JSON.stringify({ checks, fails }, null, 2));
  else for (const c of checks) console.log(`${c.level.padEnd(4)} ${c.label.padEnd(15)} ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ''}`);
  if (fails) process.exitCode = 1;
  hint(withContext(fails ? 'learn-from-mistakes-axi doctor' : 'learn-from-mistakes-axi retro --wait 8m', fails ? `again after the ${fails === 1 ? 'fix' : `${fails} fixes`} above` : 'read the sources as a saved run', opts));
}

// `init` prints the config it wrote or found (with its gaps and any source detection it skipped, with the cause), and
// one line on who sees record excerpts. A gap does not fail it: the config is written, and the hint names the fix.
async function initCommand(opts) {
  quietSqlite();
  const out = await init(opts.dir ?? resolve('.'), opts);
  console.log(render(out, opts.json));
  if (!opts.json && out.ignored.length) console.log(`${out.ignored.join(' ')} not applied: ${PROJECT_FILE} exists (edit it to change them)`);
  const seen = [['worker', out.workerBin, out.worker], ['judge', out.judgeBin, out.judge]].map(([name, bin, r]) => `the ${name} (${bin ? r.runner : 'no usable runner'})`).join(' and ');
  if (!opts.json) console.log(out.excerpts === 'on' ? `excerpts on: ${seen} see redacted record excerpts; excerpts: off in ${PROJECT_FILE} sends pointers and counts only`
    : 'excerpts off: the worker and the judge get pointers and counts only, never record text');
  if (out.gaps.some((g) => g.startsWith('worker:'))) hint(out.anyUsable ? `set worker.runner in ${PROJECT_FILE} to a usable agent CLI, or use a model one agent CLI lists` : INSTALL_FIX);
  else if (out.gaps.some((g) => g.startsWith('judge:'))) hint(out.judgeBin ? JUDGE_FIX : AGENTS_FIX);
  else hint(withContext('learn-from-mistakes-axi retro --wait 8m', 'read the sources as a saved run', opts));
}

// Run only as the CLI, through the npm bin symlink too; importing this file runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}`);
    hint(e.next);
    process.exit(e.code);
  }
}
