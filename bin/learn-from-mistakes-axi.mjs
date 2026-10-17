#!/usr/bin/env node
// learn-from-mistakes-axi: find repeated causes in the record of past work. Sources are only read; state goes to the state dir,
// <project>/.lfm by default, which the tool git-ignores itself.
// Judgement (is this line a failure, which cause, which earlier line it repeats) comes from a retro's worker; this file only parses, dedups and counts.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode as toonEncode } from '@toon-format/toon';
import { isMetric, loadConfig, loadGlobal, METRIC_RULE, MODEL_RULE, modelOk, PROJECT_FILE, RULE, SOURCES } from '../src/config.mjs';
import { abort, attach, lastRun, logs, rerun, retro, runs, status, worker } from '../src/run.mjs';
import { doctor } from '../src/doctor.mjs';
import { init, RECONFIGURABLE } from '../src/init.mjs';
import { askError, closeAsk, ensureAgents, interactive, saveCommand, sessionsCommand } from '../src/ask.mjs';
import { agents, chooseFix, detect, resolveRoles, RUNNERS, which } from '../src/runners/index.mjs';
import { repeats } from '../src/check.mjs';
import { redact } from '../src/redact.mjs';
import { openStore } from '../src/store.mjs';
import { signoff } from '../src/signoff.mjs';
import { apply, applyRun } from '../src/apply.mjs';

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
      ? `mv <project>/.lfm <elsewhere>   # free .lfm for the state dir, or set state_root in ${shq(cfg.globalPath)}`
      : `edit state_root in ${shq(cfg.globalPath)}   # a dir lfm can create and write`);
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

// A state file a retro's collect step wrote: missing or corrupt is exit 2, fixed by a new retro.
function readJsonl(file, again) {
  if (!existsSync(file)) throw new UsageError(`${file} missing`, again);
  return readText(file).split('\n').flatMap((l, i) => {
    if (!l.trim()) return [];
    try { return [JSON.parse(l)]; } catch { throw new UsageError(`${file}:${i + 1}: not valid JSON`, again); }
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
      && typeof e.ref === 'string' && e.ref && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at))
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
export const measure = (e) => ({ metric: e.metric ?? `cause_count:${e.cause}`, tripwire: e.tripwire ?? '', kind: e.kind ?? KINDS[0] });
const UNPRINTABLE = /[\p{Cc}\u2028\u2029]/u;
// A value the user typed, safe to echo: quoted, or a placeholder when long or not printable.
export const shown = (v) => ([...v].length > 80 || UNPRINTABLE.test(v) ? '(invalid value)' : JSON.stringify(v));
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
// --proposal <run>:<n> takes the cause, metric and tripwire of that run's kept fix n; --metric and --tripwire override them.
export const recordableCauses = (cfg) => Object.keys(cfg.causes).filter((c) => c !== 'other');
export async function recordChange(cfg, opts) {
  const form = FORMS['change-applied'];
  if (opts.proposal !== undefined) {
    if (opts.cause !== undefined) throw new UsageError('pass --cause or --proposal, not both', form);
    const [, run, n] = /^([1-9]\d{0,8}):([1-9]\d{0,2})$/.exec(opts.proposal) ?? [];
    if (!run) throw new UsageError(`--proposal ${shown(opts.proposal)} must be <run>:<n>, a run id and the number of one of its kept fixes`, form);
    quietSqlite();
    const db = await openStore(cfg.state, false);
    const fix = db?.prepare('SELECT cause, metric, tripwire FROM proposals WHERE run_id = ? AND n = ?').get(Number(run), Number(n));
    db?.close();
    if (!fix) throw new UsageError(`run ${run} has no kept fix ${n}`, withContext(`learn-from-mistakes-axi status --run ${run}`, 'its kept fixes', opts));
    opts = { ...opts, cause: fix.cause, metric: opts.metric ?? fix.metric, tripwire: opts.tripwire ?? fix.tripwire };
  }
  if (opts.cause === undefined) throw new UsageError('change applied needs --cause or --proposal', form);
  if (opts.ref === undefined) throw new UsageError('change applied needs --ref', form);
  const known = recordableCauses(cfg);
  if (!known.includes(opts.cause)) {
    const list = `known: ${known.join(', ') || `none, add causes to ${PROJECT_FILE}`}`;
    throw new UsageError(opts.cause === 'other' ? `cause "other" is reserved and never recordable (${list})` : `unknown cause ${shown(opts.cause)} (${list}; "other" is reserved)`, form);
  }
  if (!REF_RE.test(opts.ref)) throw new UsageError(`--ref ${shown(opts.ref)} must be a 7-40 lowercase hex commit or sha256:<64 lowercase hex>`, 'git rev-parse HEAD   # a commit id to pass as --ref');
  // A hex ref that names no commit would make the follow-up measure a change that never happened, so a git project
  // verifies it before anything is written. A sha256:<hex> version id is never a git ref; no git binary verifies
  // nothing (doctor already warns); outside a git repo there is nothing to check.
  const gitBin = which('git');
  if (/^[0-9a-f]{7,40}$/.test(opts.ref) && gitBin) {
    const inRepo = (args) => spawnSync(gitBin, ['-C', cfg.dir, ...args], { encoding: 'utf8' }).status === 0;
    if (inRepo(['rev-parse', '--show-toplevel']) && !inRepo(['rev-parse', '--verify', '--quiet', `${opts.ref}^{commit}`]))
      throw new InputError(`--ref ${shown(opts.ref)} names no commit in this git project`, 'git log --oneline -5   # a commit id to pass as --ref');
  }
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
  return entry; // what/why leave only through `learn-from-mistakes-axi changes`
}

// lfm-changes.v1: every applied change in ledger order. The join key is `project` + `id`.
function exportChanges(cfg, opts, json) {
  const changes = cleanLedger(join(cfg.state, 'changes.jsonl'), opts).map((e) => ({ id: e.id, cause: e.cause, ref: e.ref, at: e.at, ...measure(e), what: e.what ?? '', why: e.why ?? '' }));
  console.log(render({ schema: 'lfm-changes.v1', generated_at: new Date().toISOString(), project: cfg.name, changes }, json));
  if (!changes.length) hint(withContext('learn-from-mistakes-axi change applied --cause <cause> --ref <ref> --what <text> --why <text>', 'record a change you already made', opts));
  else hint(json ? withContext('learn-from-mistakes-axi report', 'the per-cause counts', opts) : withContext('learn-from-mistakes-axi changes --json', 'the same export as JSON', opts));
}

// The id a gate row or PR takes in records.jsonl and the store's record_id: its source's name and its own id.
export const recordId = (r) => `${r.source}:${r.id}`;

export const sourceLine = (s) => `${s.id.padEnd(12)} ${s.type.padEnd(13)} ${String(s.items).padStart(5)} items`;

// Spreading an unbounded array overflows the call stack (RangeError: Maximum call stack size
// exceeded), so sources stream into the store in chunks instead of one spread push.
const PUSH_CHUNK = 8192;
function pushAll(target, items) {
  for (let i = 0; i < items.length; i += PUSH_CHUNK) target.push(...items.slice(i, i + PUSH_CHUNK));
}
const STACK_OVERFLOW_RE = /maximum call stack size exceeded/i;
// A source that still throws names the source and how many records it had read, and a raw engine
// RangeError becomes a fix line instead of an unnamed crash.
function sourceError(id, e, count) {
  const overflow = e instanceof RangeError || STACK_OVERFLOW_RE.test(e.message ?? '');
  const tagged = /^source\s/.test(e.message ?? '') ? e.message : `source ${id}: ${e.message}`;
  const next = overflow
    ? `split source ${id} into smaller reads (fewer records in one read), then learn-from-mistakes-axi retro --wait 8m`
    : e instanceof UsageError ? e.next : `fix source ${id} (see its message), then learn-from-mistakes-axi retro --wait 8m`;
  return new UsageError(`${tagged} (${count} records read)`, next);
}

// The start of the range a retro reads: this window and the last, back to the
// before-numbers of the earliest applied change. Doctor checks this same range,
// so a record the retro reads is never one doctor skipped.
export function ingestReadFrom(cfg, now = Date.now()) {
  const w = parseInt(cfg.window, 10) * 86_400_000, since = now - w;
  return Math.min(since - w, ...readLedger(join(cfg.state, 'changes.jsonl')).entries.map((c) => Date.parse(c.at) - w));
}

// Reads every configured source into the state dir. Returns each source's id, type, item count and hash (plus the
// session counts of a sessions source), the items read, the start of this window and the last, and of the read range.
// The sessions the tool's own runs started (the run store's `invocations` table) are skipped, and a defect log's record
// ids are keyed with the store's salt (its `secret` table).
export async function ingest(cfg, db) {
  stateDir(cfg);
  const skip = new Set(db.prepare('SELECT session_id FROM invocations WHERE session_id IS NOT NULL').all().map((r) => r.session_id));
  const { salt } = db.prepare('SELECT salt FROM secret').get();
  // This window and the last, and far enough back to have before-numbers for every applied change.
  const w = parseInt(cfg.window, 10) * 86_400_000, since = Date.now() - w, iso = (ms) => new Date(ms).toISOString();
  const readFrom = ingestReadFrom(cfg);
  const records = [], rows = [], events = [], prs = [], sources = [];
  for (const [id, s] of Object.entries(cfg.sources)) {
    let got;
    try {
      got = await SOURCES[s.type].read(id, s, { readFrom, excerpts: cfg.excerpts === 'on', skip, causes: cfg.causes, project: join(cfg.dir, PROJECT_FILE), salt });
      pushAll(records, got.records ?? []);
      pushAll(rows, got.rows ?? []);
      pushAll(events, got.events ?? []);
      pushAll(prs, got.prs ?? []);
    } catch (e) {
      const count = got ? (got.records ?? got.rows ?? got.events ?? got.prs).length : 0;
      throw sourceError(id, e, count);
    }
    sources.push({ id, type: s.type, items: (got.records ?? got.rows ?? got.events ?? got.prs).length, hash: got.hash,
      ...(got.events && { sessions: got.sessions, skipped: got.skipped }) });
  }
  const jsonl = (a) => a.map((x) => JSON.stringify(x)).join('\n') + (a.length ? '\n' : '');
  // records.jsonl holds a record's text only with excerpts on, redacted; with excerpts off it has no text field.
  const forAgent = ({ text, ...rest }) => (cfg.excerpts === 'on' ? { ...rest, text: redact(text ?? '') } : rest);
  writeFileSync(join(cfg.state, 'records.jsonl'), jsonl([...records,
    ...rows.map((r) => ({ id: recordId(r), source: r.source, date: r.at.slice(0, 10), text: r.error })),
    ...prs.map((r) => ({ id: recordId(r), source: r.source, date: r.ts.slice(0, 10), text: r.text }))].map(forAgent)));
  writeFileSync(join(cfg.state, 'rows.jsonl'), jsonl(rows.map(({ error, ...r }) => (cfg.excerpts === 'on' ? { ...r, error } : r))));
  writeFileSync(join(cfg.state, 'sources.json'), JSON.stringify({ read_at: new Date().toISOString(), sources }, null, 1));
  return { sources, events, records, rows, prs, read_from: iso(readFrom), current_start: iso(since), previous_start: iso(since - w) };
}

function analyse(cfg, files) {
  const reingest = withContext(RETRO, 'a new run reads the configured sources', files);
  const records = new Map(readJsonl(join(cfg.state, 'records.jsonl'), reingest).map((r) => [r.id, r]));
  const rows = readJsonl(join(cfg.state, 'rows.jsonl'), reingest);
  const metaFile = join(cfg.state, 'sources.json');
  if (!existsSync(metaFile)) throw new UsageError(`${metaFile} missing`, reingest);
  let meta;
  try { meta = JSON.parse(readText(metaFile)); } catch (e) { if (e instanceof UsageError) throw e; throw new UsageError(`${metaFile}: not valid JSON`, reingest); }
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.sources)) throw new UsageError(`${metaFile}: not valid sources state`, reingest);
  const problems = [];
  const { entries: changes, problems: ledgerProblems } = readLedger(join(cfg.state, 'changes.jsonl'));
  problems.push(...ledgerProblems);
  const labels = new Map();
  // Problem lines name the label and the rule broken, not the record's text or ref; a cause is echoed only through `shown`.
  for (const l of files.runLabels ?? []) {
    const at = `the run's label ${l._line}`;
    if (!records.has(l.id)) problems.push(`${at}: unknown record id (its record text changed or it was never ingested)`);
    else if (labels.has(l.id)) problems.push(`${at}: second label for the record labelled at line ${labels.get(l.id)._line}`);
    else if (typeof l.event !== 'boolean' || typeof l.why !== 'string' || !l.why.trim()) problems.push(`${at}: needs event (true/false) and why`);
    else if (l.event && (typeof l.cause !== 'string' || (!Object.hasOwn(cfg.causes, l.cause) && l.cause !== 'other'))) problems.push(`${at}: cause ${typeof l.cause === 'string' ? shown(l.cause) : 'that is not a string'} is not in the config`);
    else if (l.duplicate_of !== undefined && !records.has(l.duplicate_of)) problems.push(`${at}: duplicate_of names an unknown record`);
    else if (l.occurrences !== undefined && !(Number.isInteger(l.occurrences) && l.occurrences > 0)) problems.push(`${at}: occurrences must be a positive integer`);
    else labels.set(l.id, l);
  }
  const list = repeats(cfg, records, labels, rows);
  // The run's fixes as its check step left them: a fix that broke a rule is unchecked.
  const proposals = (files.proposals ?? []).map((p) => ({ ...p, refs: (Array.isArray(p.refs) ? p.refs : []).filter((ref) => records.has(ref)) }));
  return { cfg, meta, records, rows, labels, groups: list, proposals, problems, unlabelled: [...records.keys()].filter((id) => !labels.has(id)).length, changes,
    counted: files.counted, findings: files.findings ?? [], run: files.run, shown: files.shown ?? {}, reportFile: files.reportFile };
}

// The report model and the problems behind its count; throws when the sources hold nothing to count.
export function buildReport(cfg, files, full) {
  const a = analyse(cfg, files);
  // A sessions or github source always counts: a week with no sessions or PRs still has numbers.
  if (!a.records.size && !a.rows.length && !a.meta.sources.some((s) => s.items || ['sessions', 'github'].includes(s.type))) throw new EmptyError('no records or rows in the sources: nothing to count',
    withContext(RETRO, 'after fixing the source paths in .learn-from-mistakes.yaml', files));
  return { model: project(a, full), problems: a.problems };
}

// lfm-report.v2, the one shape every machine and default output may carry: identifiers, counts, metrics, follow-ups, verdict words and
// the path of the run's report.txt; `--json` prints nothing else. Record text, label `why`, proposal `change`, agent summaries and
// reasons, cause descriptions, source paths and branches never enter it.
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
      // Only non-content ids: a record id is a hash of its text (unkeyed in a run from before the store's salt), so
      // emitting one could confirm private prose.
      m.store_row_ids = g.store.rows.map(recordId);
      // A content-hash record id (a defect-log bullet) is left out by the same rule.
      m.proposal_refs = [...new Set(ps.flatMap((p) => p.refs).filter((ref) => a.records.has(ref)
        && ['no-mistakes', 'github'].includes(a.cfg.sources[a.records.get(ref).source]?.type)))];
    }
    return m;
  });
  return {
    schema: 'lfm-report.v2',
    generated_at: new Date().toISOString(),
    run: a.run, // the retro whose labels, numbers and fixes these are
    report_txt: a.reportFile ?? '', // the run's plain-text report for a person: its path only, never its text
    ingested_at: a.meta.read_at ?? '',
    coverage: { labelled: a.labels.size, total_records: a.records.size, unlabelled: a.unlabelled },
    problems: a.problems.length,
    ledger: { entries: a.changes?.length ?? 0 },
    sources: a.meta.sources.map((s) => ({ id: s.id, type: s.type, items: s.items })),
    causes,
    // The causes the run's check step counted as repeated, its own counts: the same numbers section 4 of
    // report.txt shows and the summary line prints. The `causes` block above stays the per-cause detail
    // (labels against store rows); this is the one count for what repeated.
    repeated: Object.entries(a.counted ?? {}).filter(([, c]) => c.repeated).map(([cause, c]) => ({ cause, count: c.count, days: c.days })),
    findings: a.findings.map(({ cause, count, days, verdict }) => ({ cause, count, days, verdict })), // the run worker's, counted by its check step; the summaries print as lines after the TOON report
    // The run's numbers, each applied change's follow-up and the kept fixes, as `status` shows them; empty with no run.
    metrics: a.shown.metrics ?? [],
    followups: a.shown.followups ?? [],
    fixes: a.shown.fixes ?? [],
  };
}

const render = (model, json) => (json ? JSON.stringify(model, null, 2) : toonEncode(model));

// One stdout line after the TOON report, before the stderr hints: which causes repeated, in the report's own
// order, with the same counts section 4 of report.txt shows. The model's `repeated` is the run's check-step
// count (counts() in src/check.mjs), so a cause the report names never reads as `none` here.
// Identifiers and counts only, never record text.
export function summaryLine(model) {
  const n = (v, word) => `${v} ${word}${v === 1 ? '' : 's'}`;
  const parts = (model.repeated ?? []).map((c) => `${c.cause} (${n(c.count, 'time')}/${n(c.days, 'day')})`);
  return parts.length ? `repeated: ${parts.join(', ')}` : 'repeated: none';
}

const USAGE = `usage: learn-from-mistakes-axi [<init|doctor|guide|report|change applied|changes|retro|status|
                                runs|attach|logs|abort|rerun|agents|signoff|apply>] [options]
  (no command)        print the last run's status and its summary line
  signoff post       explicitly post a completed run's kept fixes its apply step did not apply
                     (optional sign-off-axi)
  signoff answers    save Apply/Skip answers against proposals; never apply changes
  apply               the worker makes each kept fix answered Apply (or --fix <n>) on branch
                      lfm/<run>-<n> from HEAD, and records it; never your branch or work tree
  init                write $LFM_HOME/config.yaml (the agent keys, commented) and
                      .learn-from-mistakes.yaml (the sources found, the agents the user chose)
                      where each is missing, then print the resolved worker and judge and the gaps.
                      Either way, make the state dir .lfm/ and its .gitignore
  doctor              check node, git, the config, .lfm ignored, each source, the worker and judge
                      (usable, login, model), the skill per agent CLI and
                      sign-off: ok, warn or fail, with a fix: line; exit 1 on a fail
  guide               print how an agent drives a retro: init, doctor, retro, then read
                      report.txt to the user
  report              print lfm-report.v2 for the last retro: ids, counts, metrics, follow-ups,
                      verdicts and the path of report.txt, never its text;
                      --full adds evidence ids, --json prints JSON
  change applied      record an applied change in the append-only ledger
  changes             print every applied change (lfm-changes.v1) with its owner-written what/why
  retro               start a saved run in <state dir>/lfm.sqlite (collect, metrics, followup,
                      bundle, analyse, propose, verify, check, apply, report) in a background worker
                      that goes on when this terminal ends; --wait <time> waits for it,
                      --foreground runs it here. With auto_fix: <n> in the config, its apply
                      step applies the top n kept fixes as apply does, and report.txt names them as
                      applied instead of asking; 0 (the default) proposes only
  status              print the last saved run and its steps
  runs                list the saved runs, newest first
  attach              print the run's step states and log lines as they come, until it ends
  logs --step <name>  print one step's log lines
  abort               stop the running run: its worker ends and the run is cancelled
  rerun               start a new run with the current config; --run <id> names the run it
                      follows (default: the last run), and say which run it started from; --resume
                      finishes that interrupted, cancelled or failed run from its first step that
                      is not completed
  agents              list the agent CLIs the tool can start: usable, version, login presence,
                      the configured model
  --dir <dir>         project dir holding .learn-from-mistakes.yaml (default: the current dir)
  --cause <cause>     (change applied) cause key from the config, never \`other\`
  --proposal <run>:<n>  (change applied) the run's kept fix n (status --run <run> lists them): its
                        cause, metric and tripwire
  --ref <ref>         (change applied) version id: git sha (7-40 hex) or sha256:<64 hex>
  --metric <metric>   (change applied) the metric that shows whether it worked
                      (default: cause_count:<cause>)
  --tripwire <rule>   (change applied) the value that metric must reach, "<op> <number>" such as
                      "<= 0" (default: none); each retro checks it
  --kind <kind>       (change applied) what the change edited: doc, rule or code (default: doc)
  --at <time>         (change applied) time of the change, ISO-8601 (default: now)
  --what <text>       (change applied) what changed: one line, 1-200 characters, printed only by
                      \`changes\`
  --why <text>        (change applied) why it changed: one line, 1-200 characters, printed only by
                      \`changes\`
  --fix <n>           (apply) the kept fix to apply, which you accept, when no sign-off answer
                      says so; a Skip is never applied
  --run <id>          (status, attach, logs, abort, rerun, apply) the saved run
                      (default: the last one; abort: the running one; apply: the last run with
                      kept fixes)
  --step <name>       (logs) the step: collect, metrics, followup, bundle, analyse, propose, verify,
                      check, apply or report
  --wait [<time>]     (retro, rerun) wait up to 30s, 8m or 1h (default 8m) for the run to end, then
                      print it
  --live              (doctor) also make one live call per role, as agents --test (costs tokens)
  --test <runner>     (agents) one live call to that agent CLI, acp:<target> through acpx, or
                      byokit:<route> through BYOKit (costs tokens): it must answer and write
                      no file
  --agent <agent>     (init) save agent: <agent> in the project file; the user's choice, never
                      picked by the tool
  --model <model>     (init) save agent_config.<agent>.model for that agent
  --judge-agent <agent>  (init) save judge_agent: <agent>; it may be the worker's agent, which
                         then runs its one model (one model per agent)
  --judge-model <model>  (init) save agent_config.<judge agent>.model
  --sessions <agent>,...  (init) read these agents' sessions (claude, codex, opencode, pi, gemini);
                           the user's choice, never picked by the tool
  --reconfigure       (init) re-apply --agent, --model, --judge-agent, --judge-model and --sessions
                      to an existing config, replacing those keys; every other key and comment
                      stays. Without it an existing config is never changed
  --firstmate <home>  (init) add a firstmate source that reads that Firstmate home's status logs,
                      inbox, defect log and targets (opt-in, never detected)
  --no-excerpts       (init) write excerpts: off, so the agents get pointers and counts only,
                      never record text
  --no-skill, -y      (init) init installs no skill; --project-skill installs it in the project's
                      .claude/skills and .agents/skills instead of each agent's own skills dir; -y
                      asks nothing, even in a terminal
  --json (init, doctor, report, change applied, changes, retro, status, runs,
         attach, logs, abort, rerun, agents, no command)  print JSON instead of
         the default text format (report: lfm-report.v2; changes: lfm-changes.v1)
  --full (report)     add allow-listed evidence ids (never record text)
  -h, --help          show this help and the supported commands
  -v, --version       show the version
the report --json output is privacy-bounded: identifiers, counts, metrics, follow-ups, fixes and
  each finding's judge verdict word (confirmed, weakened, refuted or not judged), plus the run's
  report.txt path; the default and --full reports also print one \`finding:\` line per finding with
  its counts and verdict, never the agent's summary (it is in report.txt only), record text,
  label/proposal prose or change what/why;
\`changes\` prints only the what/why you wrote with \`change applied\``;
const HELP = `${USAGE}

next: learn-from-mistakes-axi init           # write the config for the project you are in
next: learn-from-mistakes-axi doctor         # what is wrong, and the fix for each
next: learn-from-mistakes-axi guide          # how an agent drives a retro
next: learn-from-mistakes-axi                # the last run's status and summary line
next: learn-from-mistakes-axi report         # its ids, counts, metrics, verdicts and the path of
                                             # report.txt
next: learn-from-mistakes-axi --dir <project>   # point at a project with .learn-from-mistakes.yaml
next: learn-from-mistakes-axi report --full  # add the evidence ids
next: learn-from-mistakes-axi change applied --cause <cause> --ref <ref> --what <text> --why <text>
                                             # record a change you already made
next: learn-from-mistakes-axi changes --json    # every applied change with its id, version, date,
                                                # what and why
next: learn-from-mistakes-axi retro --wait 8m   # read, label and count the sources as a saved
                                                # run, then status and runs show it
next: learn-from-mistakes-axi agents          # the agent CLIs the tool can start, their models
                                              # and the resolved worker and judge`;
// The agent procedure lives here, not in the installed skill, so a skill copy never goes stale.
const guideText = () => `learn-from-mistakes-axi guide: how an agent drives a retro. The tool reads the records, its own
agents label and judge them, and it counts. Never judge a record yourself, and never edit the
sources, AGENTS.md, CLAUDE.md or skills.

1. No .learn-from-mistakes.yaml in the project? Run: npx -y learn-from-mistakes-axi init
2. Run learn-from-mistakes-axi doctor. Fix each fail line with the fix: line under it,
   then run doctor again.
3. Run learn-from-mistakes-axi retro --wait 8m. While the run is still running, run
   learn-from-mistakes-axi attach until it ends.
4. Read the run's report.txt (report prints its path as report_txt) and tell the user what it
   says in plain words.
5. If sign-off is installed and signoff is not off, use sign-off's skill on the run's decisions;
   else ask the user the questions in section 7.
6. Once the user has made a change: learn-from-mistakes-axi change applied
   --proposal <run>:<n> --ref <git sha>

The user chooses the worker and the judge (agent:, judge_agent:, agent_config.<agent>.model);
the tool never picks one. Both always run: there is no mode without them. A run whose worker or
judge fails keeps no verdict; fix the agent, then run the command again.
When a command stops with "ask the user which agent to use", ask the user which agent and model
to use for each role, never choose for them, then run the init command it prints with their
answer, then run the stopped command again.

next: learn-from-mistakes-axi doctor`;

function hint(text) { if (text) console.error(`next: ${text}`); }
export const withContext = (base, note, opts) => `${base}   # ${note}${opts.dir ? ' (keep your --dir)' : ''}`;
// The manual flow (ingest, count, --labels, --proposals) is gone: a retro reads, labels and counts.
const RETRO = 'learn-from-mistakes-axi retro --wait 8m';
const REMOVED = ['ingest', 'count', '--labels', '--proposals'];
// The allowed form of each command; the flags it takes are read from it.
const FORMS = {
  '': 'learn-from-mistakes-axi [--dir <dir>] [--json]', // no command: the last run's status and summary line
  init: 'learn-from-mistakes-axi init [--agent <agent> [--model <model>]] [--judge-agent <agent> [--judge-model <model>]] [--sessions <agent>,...] [--reconfigure] [--firstmate <home>] [--no-excerpts] [--project-skill] [--no-skill] [-y] [--dir <dir>] [--json]',
  doctor: 'learn-from-mistakes-axi doctor [--live] [--dir <dir>] [--json]',
  guide: 'learn-from-mistakes-axi guide',
  report: 'learn-from-mistakes-axi report [--dir <dir>] [--json] [--full]',
  'change-applied': 'learn-from-mistakes-axi change applied (--cause <cause> | --proposal <run>:<n>) --ref <ref> [--metric <metric>] [--tripwire "<op> <number>"] [--kind doc|rule|code] [--at <time>] [--what <text>] [--why <text>] [--json] [--dir <dir>]',
  changes: 'learn-from-mistakes-axi changes [--dir <dir>] [--json]',
  retro: 'learn-from-mistakes-axi retro [--wait [<time>] | --foreground] [--dir <dir>] [--json]',
  status: 'learn-from-mistakes-axi status [--run <id>] [--dir <dir>] [--json]',
  runs: 'learn-from-mistakes-axi runs [--dir <dir>] [--json]',
  attach: 'learn-from-mistakes-axi attach [--run <id>] [--dir <dir>] [--json]',
  logs: 'learn-from-mistakes-axi logs --step <name> [--run <id>] [--dir <dir>] [--json]',
  abort: 'learn-from-mistakes-axi abort [--run <id>] [--dir <dir>] [--json]',
  rerun: 'learn-from-mistakes-axi rerun [--resume] [--run <id>] [--wait [<time>]] [--dir <dir>] [--json]',
  agents: 'learn-from-mistakes-axi agents [--test <runner>] [--dir <dir>] [--json]',
  'signoff-post': 'learn-from-mistakes-axi signoff post [--run <id>] [--dir <dir>]',
  'signoff-answers': 'learn-from-mistakes-axi signoff answers [--dir <dir>]',
  apply: 'learn-from-mistakes-axi apply [--run <id>] [--fix <n>] [--dir <dir>]',
};
// A role's fix: "install X" only for an agent that is not installed; the agent choice is the user's either way.
const roleFix = (cfg, key, r) => r.fix ?? `${/ is not usable:/.test(r.problem) ? `install ${r.runner.replace(/^acp:.*/, 'acpx')}, or ` : ''}${chooseFix(cfg, key, r.runner)}`;
const VALUE_FLAGS = ['--dir', '--proposal', '--cause', '--ref', '--metric', '--tripwire', '--kind', '--at', '--what', '--why', '--run', '--fix', '--wait', '--step', '--test', '--agent', '--judge-agent', '--model', '--judge-model', '--firstmate', '--sessions'];
const SWITCHES = ['--live', '--json', '--full', '--foreground', '--resume', '--no-excerpts', '--project-skill', '--no-skill', '--reconfigure', '-y'];
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const PROBLEM_LINES = 20;

async function main(ctx) {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(HELP); return; }
  if (argv.includes('-v') || argv.includes('--version')) { console.log(VERSION); return; }
  let cmd = ''; // no command, or a leading flag, shows the last run
  const named = argv[0] !== undefined && !argv[0].startsWith('-');
  if (named) cmd = argv.shift();
  if (cmd === 'change') {
    if (argv[0] !== 'applied') throw new UsageError('"change" must be followed by "applied"', FORMS['change-applied']);
    argv.shift();
    cmd = 'change-applied';
  }
  if (cmd === 'signoff') {
    if (!['post', 'answers'].includes(argv[0])) throw new UsageError('signoff needs post or answers', FORMS['signoff-post']);
    cmd = `signoff-${argv.shift()}`;
  }
  if (cmd === '_work') { await worker(loadConfig(argv[3]), Number(argv[0]), Number(argv[1])); return; } // hidden: `_work <id> <owner pid> --dir <dir>`, the worker retro spawns
  if (REMOVED.includes(cmd)) throw new UsageError(`${cmd} was removed: a retro reads the sources, labels and counts them`, RETRO);
  if (!Object.hasOwn(FORMS, cmd)) throw new UsageError(`unknown command ${shown(cmd)} (commands: init, doctor, guide, report, change applied, changes, retro, status, runs, attach, logs, abort, rerun, agents, signoff, apply)`);
  const name = cmd.replace('-', ' ') || 'learn-from-mistakes-axi', form = FORMS[cmd];
  const next = named ? form : undefined; // a bare `learn-from-mistakes-axi --bogus` points at --help
  const opts = {};
  ctx.opts = opts;
  for (let i = 0; i < argv.length;) {
    const flag = argv[i];
    if (!flag.startsWith('-')) throw new UsageError(`unexpected argument ${shown(flag)}`, next);
    if (REMOVED.includes(flag)) throw new UsageError(`${flag} was removed: a retro labels the records and checks the fixes`, RETRO);
    if (!VALUE_FLAGS.includes(flag) && !SWITCHES.includes(flag)) throw new UsageError(`unknown option ${shown(flag)}`, next);
    if (!form.includes(`${flag} `) && !form.includes(`${flag}]`)) throw new UsageError(`${name} does not take ${flag}`, next);
    if (SWITCHES.includes(flag)) { opts[flag.replace(/^--?/, '')] = true; i += 1; continue; }
    if (flag === '--wait' && !/^[^-]/.test(argv[i + 1] ?? '')) { opts.wait = '8m'; i += 1; continue; } // a bare --wait waits 8 minutes
    if (argv[i + 1] === undefined) throw new UsageError(`${flag} needs a value`, next ?? form);
    if (['--dir', '--firstmate'].includes(flag)) {
      // Paths are echoed whole in later errors so the user can find the file; a control character never is.
      if (UNPRINTABLE.test(argv[i + 1])) throw new UsageError(`${flag} (invalid value): a path must not contain control characters`, next ?? form);
      opts[flag.slice(2)] = resolve(argv[i + 1]);
    } else opts[flag.slice(2)] = argv[i + 1];
    i += 2;
  }
  const { json, full } = opts;
  if (cmd === 'guide') { console.log(guideText()); return; }
  for (const [k, re, rule] of [['run', /^[1-9]\d{0,8}$/, 'a run id that runs lists'], ['fix', /^[1-9]\d{0,2}$/, 'the number of a kept fix that status lists'], ['wait', /^[1-9]\d{0,3}[smh]$/, 'a time like 30s, 8m or 1h'], ['step', /^[a-z]{1,32}$/, 'a step name such as collect or report']]) {
    if (opts[k] !== undefined && !re.test(opts[k])) throw new UsageError(`--${k} ${shown(opts[k])} must be ${rule}`, form);
  }
  if (opts.wait) opts.wait = parseInt(opts.wait, 10) * UNIT_MS[opts.wait.at(-1)];
  if (opts.wait && opts.foreground) throw new UsageError('pass --wait or --foreground, not both', form);
  if (cmd === 'logs' && !opts.step) throw new UsageError('logs needs --step', form);
  // An acp target or a byokit route names the run dir, so it is a plain name: no path, no leading dot.
  for (const k of ['test', 'agent', 'judge-agent']) {
    if (opts[k] !== undefined && !/^(acp:[a-z0-9][\w.-]*|byokit:[a-z0-9][\w.:-]*)$/.test(opts[k]) && (opts[k] === 'acp' || !Object.hasOwn(RUNNERS, opts[k].replace(/^acp:[a-z0-9][\w.-]*$/, 'acp')))) {
      const list = Object.keys(RUNNERS).filter((r) => r !== 'acp').join(', ');
      throw new UsageError(`--${k} ${shown(opts[k])} must be an agent: ${list}, acp:<target> or byokit:<route>`, form);
    }
  }
  for (const [m, a] of [['model', 'agent'], ['judge-model', 'judge-agent']]) {
    if (opts[m] === undefined) continue;
    if (!opts[a]) throw new UsageError(`--${m} needs --${a}`, form);
    if (!modelOk(opts[a], opts[m])) throw new UsageError(`--${m} ${shown(opts[m])} must be ${MODEL_RULE}`, form);
  }
  if (cmd === 'agents') { await agentsCommand(opts); return; }
  if (cmd === 'init') { await initCommand(opts); return; }
  if (cmd === 'doctor') { await doctorCommand(opts); return; }
  let cfg = loadConfig(opts.dir ?? resolve('.'));
  ctx.state = cfg.state;
  // A retro needs both agents: a terminal is asked and the answer saved; any other caller is told to ask the user.
  if (['retro', 'rerun'].includes(cmd) && await ensureAgents(cfg, join(cfg.dir, PROJECT_FILE), opts.dir)) cfg = loadConfig(opts.dir ?? resolve('.'));
  // apply starts only the worker, and only after the store shows a run with kept fixes; the check comes first, so a
  // run with none stops before an agent it would never use is asked for or saved. Then only the worker role is asked.
  if (cmd === 'apply') {
    quietSqlite();
    let db;
    try { db = await openStore(cfg.state, false); applyRun(db, opts); } catch (e) { db?.close(); throw storeError(e, cfg, opts, cmd); }
    db?.close();
    if (await ensureAgents(cfg, join(cfg.dir, PROJECT_FILE), opts.dir, ['agent'])) cfg = loadConfig(opts.dir ?? resolve('.'));
  }
  // Both agents always run: a worker or a judge that is not ready stops the run before it starts.
  if (['retro', 'rerun'].includes(cmd)) {
    const { worker, judge } = await resolveRoles(cfg, detect(cfg));
    if (worker.problem) throw new InputError(`worker: ${worker.problem}`, roleFix(cfg, 'agent', worker));
    if (judge.problem) throw new InputError(`judge: ${judge.problem}`, roleFix(cfg, 'judge_agent', judge));
  }
  if (cmd.startsWith('signoff-')) { quietSqlite(); await signoff(cmd.slice(8), cfg, opts).catch((e) => { throw storeError(e, cfg, opts, name); }); return; }
  if (cmd === 'change-applied') { quietSqlite(); console.log(render(await recordChange(cfg, opts).catch((e) => { throw storeError(e, cfg, opts, name); }), json)); hint(withContext('learn-from-mistakes-axi report', 'the report with the ledger', opts)); return; }
  if (cmd === 'apply') { quietSqlite(); await apply(cfg, opts).catch((e) => { throw storeError(e, cfg, opts, cmd); }); return; }
  if (cmd === 'changes') { exportChanges(cfg, opts, json); return; }
  if (['', 'retro', 'status', 'runs', 'attach', 'logs', 'abort', 'rerun'].includes(cmd)) { await runCommand(cmd, cfg, opts); return; }
  quietSqlite();
  const last = await lastRun(cfg).catch((e) => { throw storeError(e, cfg, opts, cmd); });
  if (!last) throw new EmptyError(`no completed runs in ${cfg.state}`, withContext(RETRO, 'read, label and count the sources as a saved run', opts));
  if (last.latest !== last.run) console.error(`note: run ${last.latest} kept no label and no finding; showing run ${last.run}`);
  const { model, problems } = buildReport(cfg, { ...opts, ...last }, full);
  console.log(render(model, json));
  if (!json) console.log([summaryLine(model), ...last.findings.map((f) => `finding: ${f.cause} (${f.count ?? 0}/${f.days ?? 0} days, ${f.verdict})`)].join('\n'));
  if (problems.length) {
    for (const p of problems.slice(0, PROBLEM_LINES)) console.error(`problem: ${p}`);
    if (problems.length > PROBLEM_LINES) console.error(`problem: ... and ${problems.length - PROBLEM_LINES} more`);
    console.error(`problems: ${problems.length}   # fix the inputs or the change ledger`);
    hint(problems.some((p) => p.startsWith("the run's label")) ? withContext('learn-from-mistakes-axi retro --wait', 'a new run relabels the records', opts)
      : withContext('learn-from-mistakes-axi changes', 'check the ledger again after fixing those lines', opts));
    process.exitCode = 1;
    return;
  }
  hint(withContext(`learn-from-mistakes-axi status --run ${last.run}`, 'the run and its steps', opts));
}

// The run commands open the run store, and init may read a no-mistakes store. node:sqlite warns it is experimental on Node 22, so these
// commands drop that one warning; every other warning still prints.
function quietSqlite() {
  const print = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') for (const f of print) f(w); });
}
// A run store sqlite cannot use is one usage line with the file to move, never a stack trace.
function storeError(e, cfg, opts, cmd) {
  if (e.code !== 'ERR_SQLITE_ERROR' || (e.errcode & 0xff) === 5) return e; // main() maps a busy store
  const file = join(cfg.state, 'lfm.sqlite');
  if (e.message.includes('UNIQUE constraint failed: runs.status')) return new UsageError('a run is already running', withContext('learn-from-mistakes-axi runs', 'the running run', opts));
  if ([8, 10, 13, 14].includes(e.errcode & 0xff)) return new UsageError(`${file}: ${e.message}`, withContext(`learn-from-mistakes-axi${cmd ? ` ${cmd}` : ''}`, 'after the disk or the file permissions are fixed', opts));
  return new UsageError(`${file}: not a usable run store (${e.message})`, `mv ${file} <elsewhere>   # if it is not a run store; the next retro starts a new one`);
}
// A run's pid is the owner process the stale-worker check reads: --json keeps it (a schema key),
// the human output of status, runs, attach, abort, retro and rerun hides it.
const humanModel = (out) => ({
  ...out,
  ...(out.run && typeof out.run === 'object' && { run: Object.fromEntries(Object.entries(out.run).filter(([k]) => k !== 'pid')) }),
  ...(out.runs && { runs: out.runs.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'pid'))) }),
});
async function runCommand(cmd, cfg, opts) {
  quietSqlite();
  let out;
  try {
    out = await { retro, status, '': status, runs, attach, logs, abort, rerun }[cmd](cfg, opts);
  } catch (e) {
    throw storeError(e, cfg, opts, cmd);
  }
  // Bare: the run's id, status and times and its summary line; never its error, whose text can hold an agent's output.
  const last = () => ({ run: { id: out.run.id, status: out.run.status, created_at: out.run.created_at, updated_at: out.run.updated_at }, summary: out.result?.summary ?? '' });
  console.log(render(cmd === '' ? last() : opts.json ? out : humanModel(out), opts.json));
  if (cmd === 'rerun' && out.from != null) console.error(`rerun: started run ${out.run.id} from run ${out.from}`);
  if (cmd === 'runs') hint(out.runs.length ? withContext(`learn-from-mistakes-axi status --run ${out.runs[0].id}`, 'the steps of the last run', opts)
    : withContext('learn-from-mistakes-axi retro --wait 8m', 'read, label and count the sources as a saved run', opts));
  else if (cmd === 'logs') hint(withContext(`learn-from-mistakes-axi status --run ${out.run}`, 'the run and all its steps', opts));
  else if (out.run.status === 'running') hint(withContext(`learn-from-mistakes-axi attach --run ${out.run.id}`, `${opts.wait ? 'still running; ' : ''}follow its steps while the run goes on in the background`, opts));
  else if (cmd === 'abort') hint(withContext(`learn-from-mistakes-axi rerun --resume --run ${out.run.id}`, 'finish it from its first step that is not completed', opts));
  else if (out.run.status === 'failed') {
    if (cmd !== '') console.error(`error: ${out.run.error}`);
    const step = out.steps.find((s) => s.status === 'failed')?.name;
    hint(withContext(`learn-from-mistakes-axi rerun --resume --run ${out.run.id}`, `finish it after fixing ${step ? `the ${step} step` : 'the cause'}; completed steps are not run again`, opts));
    process.exitCode = 1; // the same code retro --wait uses: status and the bare command show the failed run too
  } else if (out.run.status !== 'completed') { // interrupted or cancelled
    if (cmd !== '') console.error(`error: ${out.run.error}`);
    const log = join(cfg.state, 'runs', String(out.run.id), 'worker.log');
    const output = existsSync(log) ? `; the worker's output: ${log}` : '';
    hint(withContext(`learn-from-mistakes-axi rerun --resume --run ${out.run.id}`, `finish it without running the completed steps again${output}`, opts));
    process.exitCode = 1;
  } else if (!out.result.labelled && !out.result.findings.length) {
    console.error('result: the worker labelled no record and named no finding');
    hint(withContext(`learn-from-mistakes-axi logs --step analyse --run ${out.run.id}`, 'why: nothing new in this window, or the problems with its answer', opts));
  } else hint(cmd === '' ? withContext('learn-from-mistakes-axi report', 'its ids, counts, metrics, verdicts and the path of report.txt', opts)
    : withContext('learn-from-mistakes-axi report --full', 'the evidence ids behind these counts', opts));
}

// `agents` lists the configured agents anywhere, with the resolved worker and judge from the global config and the
// project's overrides when it has a config; a role that does not resolve exits 1. With no agent set it asks (a
// terminal) or says to ask the user. `--test` writes in the project's state dir, so it needs the config.
async function agentsCommand(opts) {
  const dir = opts.dir ?? resolve('.'), project = existsSync(join(dir, PROJECT_FILE));
  const load = () => (opts.test || project ? loadConfig(dir) : loadGlobal());
  let cfg = load();
  if (!opts.test && await ensureAgents(cfg, project ? join(dir, PROJECT_FILE) : cfg.globalPath, opts.dir)) cfg = load();
  const out = await agents(cfg, opts);
  console.log(render(out, opts.json));
  if (out.test) { hint(withContext('learn-from-mistakes-axi agents', 'the configured agents and the resolved worker and judge', opts)); return; }
  const roles = ['worker', 'judge'].filter((r) => out[r].problem);
  for (const r of roles) console.error(`problem: ${r}: ${out[r].problem}`);
  if (roles.length) process.exitCode = 1;
  if (roles.includes('worker')) hint(roleFix(cfg, 'agent', out.worker));
  else if (roles.includes('judge')) hint(roleFix(cfg, 'judge_agent', out.judge));
  else hint(withContext(`learn-from-mistakes-axi agents --test ${out.worker.runner}`, 'one live call (costs tokens): the agent must answer and write no file', opts));
}

// `doctor` prints one line per check and an indented fix: line under each one that is not ok; any fail exits 1.
async function doctorCommand(opts) {
  quietSqlite();
  const dir = opts.dir ?? resolve('.');
  let cfg;
  try { cfg = loadConfig(dir); } catch (e) { if (!(e instanceof UsageError)) throw e; } // doctor reports a config error itself
  if (cfg) await ensureAgents(cfg, join(dir, PROJECT_FILE), opts.dir);
  const checks = await doctor(dir, opts);
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
  const dir = opts.dir ?? resolve('.');
  let out = await init(dir, opts);
  const { skills, skills_updated, skills_skipped, skills_roots, ...shown } = out; // text shows the skill lines below, not these
  if (!opts.json) { // workerBin/judgeBin are --json schema keys; the human output names them in plain words
    shown['worker command'] = shown.workerBin; shown['judge command'] = shown.judgeBin;
    delete shown.workerBin; delete shown.judgeBin;
  }
  console.log(render(opts.json ? out : shown, opts.json));
  if (!opts.json && out.ignored.length) {
    // --reconfigure applies only its own flags: the ignored line names the flag for those, and when both kinds are
    // ignored, which flags each part covers.
    const re = out.ignored.filter((f) => RECONFIGURABLE.includes(f)), rest = out.ignored.filter((f) => !RECONFIGURABLE.includes(f));
    const edit = rest.length && re.length ? `edit ${rest.join(' ')} to change ${rest.length > 1 ? 'them' : 'it'}` : 'edit it to change them';
    console.log(`${out.ignored.join(' ')} not applied: ${PROJECT_FILE} exists (${re.length ? `${edit}, or init --reconfigure to apply ${re.join(' ')}` : edit})`);
  }
  for (const f of !opts.json ? out.skills ?? [] : []) console.log(`skill: ${out.skills_updated.includes(f) ? 'updated ' : ''}${f}`);
  for (const f of !opts.json ? out.skills_skipped ?? [] : []) console.log(`skipped: ${f}`);
  if (!opts.json && !opts['no-skill'] && !out.skills_roots) console.log('skills: no configured agent has a skills dir');
  else if (!opts.json && !opts['no-skill'] && !(out.skills ?? []).length && !(out.skills_skipped ?? []).length) console.log('skills: nothing new');
  const seen = [['worker', out.workerBin, out.worker], ['judge', out.judgeBin, out.judge]].map(([name, bin, r]) => `the ${name} (${bin ? r.runner : r.runner ? `${r.runner}, not usable` : 'not set'})`).join(' and ');
  if (!opts.json) console.log(out.excerpts === 'on' ? `excerpts on: ${seen} see redacted record excerpts; excerpts: off in ${PROJECT_FILE} sends pointers and counts only`
    : 'excerpts off: the worker and the judge get pointers and counts only, never record text');
  if (!opts.y && out.missing.length && interactive() && await ensureAgents(loadConfig(dir), join(dir, PROJECT_FILE), opts.dir)) out = await init(dir, opts);
  const cfg = loadConfig(dir);
  const problem = (name) => out.gaps.find((g) => g.startsWith(`${name}: `))?.slice(name.length + 2);
  if (out.missing.length && !opts.y) { // after what it wrote: the ask stops init, as it stops every command
    const e = askError(cfg, out.missing, opts.dir);
    console.error(`error: ${e.message}`);
    hint(e.next);
    process.exitCode = e.code;
  } else if (out.missing.length) hint(saveCommand(out.missing, opts.dir));
  else if (problem('worker')) hint(roleFix(cfg, 'agent', { runner: out.worker.runner, problem: problem('worker') }));
  else if (problem('judge')) hint(roleFix(cfg, 'judge_agent', { runner: out.judge.runner, problem: problem('judge') }));
  else if (problem('sessions')) hint(sessionsCommand(opts.dir));
  else hint(withContext('learn-from-mistakes-axi retro --wait 8m', 'read the sources as a saved run', opts));
}

// Run only as the CLI, through the npm bin symlink too; importing this file runs nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = {};
  try { await main(ctx); closeAsk(); } catch (raw) {
    // SQLITE_BUSY: another process held the store past busy_timeout. The store is fine and keeps the run history.
    const busy = raw.code === 'ERR_SQLITE_ERROR' && (raw.errcode & 0xff) === 5 && ctx.state !== undefined;
    const e = busy ? new UsageError(`${join(ctx.state, 'lfm.sqlite')} is busy: another learn-from-mistakes-axi process is writing it`, withContext('learn-from-mistakes-axi status', 'wait a moment and check the running run; abort --run <id> stops it', ctx.opts)) : raw;
    if (!(e instanceof UsageError)) throw e;
    console.error(`error: ${e.message}`);
    hint(e.next);
    process.exit(e.code);
  }
}
