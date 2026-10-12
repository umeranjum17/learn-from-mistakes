#!/usr/bin/env node
// lfm: find repeated causes in the record of past work. Sources are only read; state goes to the state dir.
// Judgement (is this line a failure, which cause, which earlier line it repeats) comes from an agent's
// labels.jsonl; this file only parses, dedups and counts.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encode as toonEncode } from '@toon-format/toon';
import { parse } from 'yaml';

class UsageError extends Error {}
const LFM_HOME = process.env.LFM_HOME || join(homedir(), '.learn-from-mistakes');
const PROJECT_FILE = '.learn-from-mistakes.yaml';
const TYPES = ['markdown-log', 'no-mistakes'];
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function readYaml(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw new UsageError(`${file}: ${e.message}`); }
  try { return parse(text) ?? {}; } catch (e) { throw new UsageError(`${file}: ${e.message.split('\n')[0]}`); }
}
function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch (e) { throw new UsageError(`${file}: cannot read (${e.code})`); }
}
function mapping(value, keys, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${where} must be a mapping`);
  for (const k of Object.keys(value)) if (keys && !keys.includes(k)) throw new UsageError(`${where}: unknown key ${k}`);
  return value;
}
const expand = (p, dir) => resolve(dir, p.replace(/^~(?=\/|$)/, homedir()));

function loadConfig(dir) {
  const global = mapping(readYaml(join(LFM_HOME, 'config.yaml')) ?? {}, ['state_root'], join(LFM_HOME, 'config.yaml'));
  const file = join(dir, PROJECT_FILE);
  const p = readYaml(file);
  if (p === undefined) throw new UsageError(`no ${PROJECT_FILE} in ${dir}`);
  mapping(p, ['name', 'sources', 'causes', 'repeat'], file);
  const sources = mapping(p.sources ?? {}, null, `${file}: sources`);
  for (const [id, s] of Object.entries(sources)) {
    mapping(s, ['type', 'path'], `${file}: sources.${id}`);
    if (!TYPES.includes(s.type)) throw new UsageError(`${file}: sources.${id}.type must be one of ${TYPES.join(', ')}`);
    if (typeof s.path !== 'string') throw new UsageError(`${file}: sources.${id}.path must be a string`);
    s.path = expand(s.path, dir);
  }
  const causes = mapping(p.causes ?? {}, null, `${file}: causes`);
  for (const [id, c] of Object.entries(causes)) {
    mapping(c, ['description', 'match'], `${file}: causes.${id}`);
    if (typeof c.description !== 'string') throw new UsageError(`${file}: causes.${id}.description must be a string`);
    if (c.match === undefined) continue;
    const m = mapping(c.match, ['source', 'error_contains'], `${file}: causes.${id}.match`);
    if (sources[m.source]?.type !== 'no-mistakes') throw new UsageError(`${file}: causes.${id}.match.source must name a no-mistakes source`);
    if (typeof m.error_contains !== 'string' || !m.error_contains) throw new UsageError(`${file}: causes.${id}.match.error_contains must be a non-empty string`);
  }
  const repeat = { min_incidents: 3, min_days: 2, ...mapping(p.repeat ?? {}, ['min_incidents', 'min_days'], `${file}: repeat`) };
  for (const [k, v] of Object.entries(repeat)) if (!Number.isInteger(v) || v < 1) throw new UsageError(`${file}: repeat.${k} must be a positive integer`);
  const name = p.name ?? basename(dir);
  const root = global.state_root ? expand(String(global.state_root), LFM_HOME) : join(LFM_HOME, 'state');
  return { name, sources, causes, repeat, state: join(root, name) };
}

// Each top-level "- " bullet is one record. Its id comes from its text, so it survives line moves.
function readLog(source, path) {
  const text = readText(path);
  const seen = new Map();
  let date = '';
  const records = [];
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('## ')) date = line.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
    if (!line.startsWith('- ')) return;
    const body = line.slice(2).trim();
    let id = createHash('sha256').update(body.toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 12);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id += `~${n}`;
    records.push({ id, source, line: i + 1, date: body.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? date, text: body });
  });
  return { records, hash: createHash('sha256').update(text).digest('hex') };
}

// Failed pipeline steps from a no-mistakes state database, opened read-only. One fixed query; no user SQL.
function readStore(source, path) {
  if (!existsSync(path)) throw new UsageError(`${path}: no such file`);
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`SELECT s.id, s.run_id, s.step_name, s.error, COALESCE(s.completed_at, s.started_at) AS t, r.branch
      FROM step_results s JOIN runs r ON r.id = s.run_id WHERE s.status = 'failed' ORDER BY t, s.id`).all();
    return { rows: rows.map((r) => ({ id: r.id, source, run: r.run_id, step: r.step_name, branch: r.branch,
      at: r.t ? new Date(r.t > 1e11 ? r.t : r.t * 1000).toISOString() : '', error: r.error ?? '' })),
      hash: `mtime ${statSync(path).mtime.toISOString()}` };
  } catch (e) {
    throw new UsageError(`${path}: not a readable no-mistakes store (${e.message})`);
  } finally { db?.close(); }
}

function readJsonl(file, required) {
  if (!existsSync(file)) { if (required) throw new UsageError(`${file} missing: run lfm ingest first`); return []; }
  return readText(file).split('\n').flatMap((l, i) => {
    if (!l.trim()) return [];
    try { return [{ ...JSON.parse(l), _line: i + 1 }]; } catch { throw new UsageError(`${file}:${i + 1}: not valid JSON`); }
  });
}

// The append-only change ledger: one JSON object per line, ids/cause keys/times only.
// A missing file means zero entries, never an error. Problems name file:line only,
// never line contents, so a corrupt ledger stays privacy-bounded too.
function readLedger(file) {
  if (!existsSync(file)) return { entries: [], problems: [] };
  const entries = [], problems = [];
  readText(file).split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { problems.push(`${file}:${i + 1}: not valid JSON`); return; }
    const ok = e && typeof e === 'object' && !Array.isArray(e) && e.v === 1
      && typeof e.id === 'string' && e.id && typeof e.cause === 'string' && e.cause
      && typeof e.ref === 'string' && e.ref && typeof e.at === 'string' && e.at;
    if (!ok) problems.push(`${file}:${i + 1}: not a valid change entry`);
    else entries.push(e);
  });
  return { entries, problems };
}

const REF_RE = /^(?:[0-9a-f]{7,40}|sha256:[0-9a-f]{64})$/;

// ponytail: single-writer ledger. The id is entries + 1 and the write is one
// O_APPEND call, so a lone writer can never interleave or repeat an id.
// Concurrent writers could read the same length and repeat one; a lock file is the upgrade.
function recordChange(cfg, opts, json) {
  if (opts.cause === undefined || opts.ref === undefined) throw new UsageError(USAGE);
  if (!Object.hasOwn(cfg.causes, opts.cause) || opts.cause === 'other') throw new UsageError(USAGE);
  if (!REF_RE.test(opts.ref)) throw new UsageError(USAGE);
  let at;
  if (opts.at === undefined) at = new Date().toISOString();
  else {
    const ms = Date.parse(opts.at);
    if (Number.isNaN(ms)) throw new UsageError(USAGE);
    at = new Date(ms).toISOString();
  }
  const file = join(cfg.state, 'changes.jsonl');
  const { entries, problems } = readLedger(file);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  const entry = { v: 1, id: `chg-${entries.length + 1}`, cause: opts.cause, ref: opts.ref, at };
  mkdirSync(cfg.state, { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + '\n');
  console.log(render(entry, json));
  hint(withContext('lfm report', 'the report with the ledger', opts));
}

function readInput(file, explicit) {
  if (explicit && !existsSync(file)) throw new UsageError(`${file}: no such file`);
  return readJsonl(file, false);
}

function ingest(cfg, opts) {
  mkdirSync(cfg.state, { recursive: true });
  const records = [], rows = [], sources = [];
  for (const [id, s] of Object.entries(cfg.sources)) {
    const got = s.type === 'markdown-log' ? readLog(id, s.path) : readStore(id, s.path);
    records.push(...(got.records ?? []));
    rows.push(...(got.rows ?? []));
    sources.push({ id, type: s.type, path: s.path, items: (got.records ?? got.rows).length, hash: got.hash });
  }
  const jsonl = (a) => a.map((x) => JSON.stringify(x)).join('\n') + (a.length ? '\n' : '');
  writeFileSync(join(cfg.state, 'records.jsonl'), jsonl(records));
  writeFileSync(join(cfg.state, 'rows.jsonl'), jsonl(rows));
  writeFileSync(join(cfg.state, 'sources.json'), JSON.stringify({ read_at: new Date().toISOString(), sources }, null, 1));
  for (const s of sources) console.log(`${s.id.padEnd(12)} ${s.type.padEnd(13)} ${String(s.items).padStart(5)} items  ${s.hash.startsWith('mtime') ? s.hash : `sha256 ${s.hash.slice(0, 12)}`}`);
  console.log(`state: ${cfg.state}\nnext: label records.jsonl into labels.jsonl (see the learn-from-mistakes skill), then ${withContext('lfm count', 'the counts', opts)}`);
}

function analyse(cfg, files) {
  const records = new Map(readJsonl(join(cfg.state, 'records.jsonl'), true).map((r) => [r.id, r]));
  const rows = readJsonl(join(cfg.state, 'rows.jsonl'), true);
  const metaFile = join(cfg.state, 'sources.json');
  if (!existsSync(metaFile)) throw new UsageError(`${metaFile} missing: run lfm ingest first`);
  let meta;
  try { meta = JSON.parse(readText(metaFile)); } catch (e) { if (e instanceof UsageError) throw e; throw new UsageError(`${metaFile}: not valid JSON`); }
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.sources)) throw new UsageError(`${metaFile}: not valid sources state (run lfm ingest again)`);
  const problems = [];
  const { entries: changes, problems: ledgerProblems } = readLedger(join(cfg.state, 'changes.jsonl'));
  problems.push(...ledgerProblems);
  const labels = new Map();
  const lf = files.labels ?? join(cfg.state, 'labels.jsonl'), pf = files.proposals ?? join(cfg.state, 'proposals.jsonl');
  for (const l of readInput(lf, files.labels)) {
    const at = `${basename(lf)}:${l._line}`;
    if (!records.has(l.id)) problems.push(`${at}: unknown record id ${l.id}`);
    else if (labels.has(l.id)) problems.push(`${at}: second label for ${l.id}`);
    else if (typeof l.event !== 'boolean' || typeof l.why !== 'string' || !l.why.trim()) problems.push(`${at}: needs event (true/false) and why`);
    else if (l.event && (typeof l.cause !== 'string' || (!Object.hasOwn(cfg.causes, l.cause) && l.cause !== 'other'))) problems.push(`${at}: cause ${l.cause} is not in the config`);
    else if (l.duplicate_of !== undefined && !records.has(l.duplicate_of)) problems.push(`${at}: duplicate_of names unknown record ${l.duplicate_of}`);
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
    for (const row of rows) if (row.source === c.match.source && row.error.includes(c.match.error_contains)) {
      group(cause).store.rows.push(row);
      group(cause).store.days.add(row.at.slice(0, 10));
    }
  }
  const { min_incidents: mi, min_days: md } = cfg.repeat;
  const list = Object.values(groups).map((g) => {
    const incidents = [...g.log.roots.values()].reduce((a, b) => a + b, 0);
    const logRepeated = incidents >= mi && g.log.days.size >= md, storeRepeated = g.store.rows.length >= mi && g.store.days.size >= md;
    return { ...g, incidents, repeated: g.cause !== 'other' && (logRepeated || storeRepeated), by: [logRepeated && 'log', storeRepeated && 'store'].filter(Boolean) };
  }).sort((a, b) => b.repeated - a.repeated || Math.max(b.incidents, b.store.rows.length) - Math.max(a.incidents, a.store.rows.length));
  const proposals = readInput(pf, files.proposals).map((p) => {
    const refs = Array.isArray(p.refs) ? p.refs : [];
    const resolves = (ref) => records.has(ref) || rows.some((r) => `${r.source}:${r.id}` === ref);
    const missing = refs.filter((ref) => !resolves(ref));
    const bad = typeof p.cause !== 'string' || !groups[p.cause] ? `cause ${p.cause} has no counted events` : !refs.length ? 'no evidence refs' : missing.length ? `refs not found: ${missing.join(', ')}` : !p.change ? 'no change text' : '';
    if (bad) problems.push(`${basename(pf)}:${p._line}: ${bad}`);
    return { ...p, refs: refs.filter(resolves), ok: !bad };
  });
  return { cfg, meta, records, rows, labels, groups: list, proposals, problems, unlabelled: [...records.keys()].filter((id) => !labels.has(id)).length, changes };
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
    generated_at: a.meta.read_at ?? '',
    coverage: { labelled: a.labels.size, total_records: a.records.size, unlabelled: a.unlabelled },
    problems: a.problems.length,
    ledger: { entries: a.changes?.length ?? 0 },
    sources: a.meta.sources.map((s) => ({ id: s.id, type: s.type, items: s.items })),
    causes,
  };
}

const render = (model, json) => (json ? JSON.stringify(model, null, 2) : toonEncode(model));

const USAGE = `usage: lfm [<ingest|count|report|change applied>] [options]
  lfm                 print the project's repeated-cause report (same as \`lfm report\`)
  ingest              read the configured sources (read-only) into the state dir
  count               print the counts (same projection as \`lfm report\`)
  report              print the report; --full adds evidence ids, --json prints JSON
  change applied      record an applied change in the append-only ledger
  --dir <dir>         project dir holding .learn-from-mistakes.yaml (default: the current dir)
  --labels <file>     labels.jsonl to read (default: the state dir)
  --proposals <file>  proposals.jsonl to read (default: the state dir)
  --cause <cause>     (change applied) cause key from the config, never \`other\`
  --ref <ref>         (change applied) version id: git sha (7-40 hex) or sha256:<64 hex>
  --at <time>         (change applied) time of the change, ISO-8601 (default: now)
  --json (report, count, change applied)  print lfm-report.v1 as JSON instead of the default TOON
  --full (report, count)  add allow-listed evidence ids (never record text)
  -h, --help          show this help and the supported commands
  -v, --version       show the version
every output is privacy-bounded: identifiers and counts only, never record text or label/proposal prose`;
const HELP = `${USAGE}

next: lfm                        # the report for the project you are in
next: lfm --dir <project>        # point at a project with .learn-from-mistakes.yaml
next: lfm report --full          # add the evidence ids
next: lfm report --json          # the same report as JSON
next: lfm change applied --cause <cause> --ref <ref>   # record a change you already made`;

function hint(text) { if (text) console.error(`next: ${text}`); }
const INPUT_FLAGS = ['dir', 'labels', 'proposals'];
const withContext = (base, note, opts) => {
  const flags = INPUT_FLAGS.filter((k) => opts[k]).map((k) => `--${k}`);
  return flags.length ? `${base}   # ${note} (keep your ${flags.join(' ')})` : `${base}   # ${note}`;
};
const NEXT = (json, full, opts) => {
  if (full && json) return '';
  const detail = full || json ? '--full --json' : '--full';
  return withContext(`lfm report ${detail}`, full ? 'the same report as JSON' : 'add the evidence ids', opts);
};
const COMMANDS = ['ingest', 'count', 'report', 'change-applied'];

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) { console.log(HELP); return; }
  if (argv.includes('-v') || argv.includes('--version')) { console.log(VERSION); return; }
  let cmd = 'report'; // no command, or a leading flag, runs the main report job
  if (argv[0] !== undefined && !argv[0].startsWith('-')) cmd = argv.shift();
  if (cmd === 'change') {
    if (argv.shift() !== 'applied') throw new UsageError(USAGE);
    cmd = 'change-applied';
  }
  if (!COMMANDS.includes(cmd)) throw new UsageError(USAGE);
  const opts = {};
  let json = false, full = false;
  for (let i = 0; i < argv.length;) {
    const flag = argv[i];
    if (flag === '--json' || flag === '--full') { if (flag === '--json') json = true; else full = true; i += 1; }
    else if (['--dir', '--labels', '--proposals'].includes(flag) && argv[i + 1] !== undefined) { opts[flag.slice(2)] = resolve(argv[i + 1]); i += 2; }
    else if (['--cause', '--ref', '--at'].includes(flag) && argv[i + 1] !== undefined) { opts[flag.slice(2)] = argv[i + 1]; i += 2; }
    else throw new UsageError(USAGE);
  }
  const cfg = loadConfig(opts.dir ?? resolve('.'));
  if (cmd === 'ingest' && (json || full)) throw new UsageError(USAGE);
  if (cmd === 'ingest') { ingest(cfg, opts); hint(withContext('lfm', 'the report for this project', opts)); return; }
  if (cmd === 'change-applied') {
    if (full || opts.labels !== undefined || opts.proposals !== undefined) throw new UsageError(USAGE);
    recordChange(cfg, opts, json);
    return;
  }
  if (opts.cause !== undefined || opts.ref !== undefined || opts.at !== undefined) throw new UsageError(USAGE);
  const a = analyse(cfg, opts);
  if (!a.records.size && !a.rows.length) {
    console.error('no records or rows in the sources: nothing to count');
    hint(withContext('lfm ingest', 'read the configured sources, or fix source paths in .learn-from-mistakes.yaml', opts));
    process.exit(3);
  }
  console.log(render(project(a, full), json));
  if (a.problems.length) {
    console.error(`problems: ${a.problems.length}   # fix the inputs or the change ledger`);
    hint(withContext(`lfm report${full ? ' --full' : ''}${json ? ' --json' : ''}`, 'run again after fixing', opts));
    process.exit(1);
  }
  hint(NEXT(json, full, opts));
}

try { main(); } catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  hint('lfm --help   # supported commands and options');
  process.exit(2);
}
