#!/usr/bin/env node
// lfm: find repeated causes in the record of past work. Sources are only read; state goes to the state dir.
// Judgement (is this line a failure, which cause, which earlier line it repeats) comes from an agent's
// labels.jsonl; this file only parses, dedups and counts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';

class UsageError extends Error {}
const LFM_HOME = process.env.LFM_HOME || join(homedir(), '.learn-from-mistakes');
const PROJECT_FILE = '.learn-from-mistakes.yaml';
const TYPES = ['markdown-log', 'no-mistakes'];

function readYaml(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw new UsageError(`${file}: ${e.message}`); }
  try { return parse(text) ?? {}; } catch (e) { throw new UsageError(`${file}: ${e.message.split('\n')[0]}`); }
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
  const text = readFileSync(path, 'utf8');
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
  return readFileSync(file, 'utf8').split('\n').flatMap((l, i) => {
    if (!l.trim()) return [];
    try { return [{ ...JSON.parse(l), _line: i + 1 }]; } catch { throw new UsageError(`${file}:${i + 1}: not valid JSON`); }
  });
}

function ingest(cfg) {
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
  console.log(`state: ${cfg.state}\nnext: label records.jsonl into labels.jsonl (see the learn-from-mistakes skill), then lfm count`);
}

function analyse(cfg, files) {
  const records = new Map(readJsonl(join(cfg.state, 'records.jsonl'), true).map((r) => [r.id, r]));
  const rows = readJsonl(join(cfg.state, 'rows.jsonl'), true);
  const meta = JSON.parse(readFileSync(join(cfg.state, 'sources.json'), 'utf8'));
  const problems = [];
  const labels = new Map();
  const lf = files.labels ?? join(cfg.state, 'labels.jsonl'), pf = files.proposals ?? join(cfg.state, 'proposals.jsonl');
  for (const l of readJsonl(lf, false)) {
    const at = `${basename(lf)}:${l._line}`;
    if (!records.has(l.id)) problems.push(`${at}: unknown record id ${l.id}`);
    else if (labels.has(l.id)) problems.push(`${at}: second label for ${l.id}`);
    else if (typeof l.event !== 'boolean' || typeof l.why !== 'string' || !l.why.trim()) problems.push(`${at}: needs event (true/false) and why`);
    else if (l.event && !(l.cause in cfg.causes) && l.cause !== 'other') problems.push(`${at}: cause ${l.cause} is not in the config`);
    else if (l.duplicate_of !== undefined && !records.has(l.duplicate_of)) problems.push(`${at}: duplicate_of names unknown record ${l.duplicate_of}`);
    else if (l.occurrences !== undefined && !(Number.isInteger(l.occurrences) && l.occurrences > 0)) problems.push(`${at}: occurrences must be a positive integer`);
    else labels.set(l.id, l);
  }
  // A duplicate collapses into the record it repeats; that root is one incident, or `occurrences` of them.
  const root = (id, seen = new Set()) => {
    const d = labels.get(id)?.duplicate_of;
    return !d || seen.has(id) || labels.get(d)?.cause !== labels.get(id).cause || !labels.get(d).event ? id : root(d, seen.add(id));
  };
  const groups = {};
  const group = (cause) => (groups[cause] ??= { cause, description: cfg.causes[cause]?.description ?? 'Events no listed cause names.',
    log: { roots: new Map(), records: [], days: new Set() }, store: { rows: [], days: new Set() } });
  for (const l of labels.values()) {
    if (!l.event) continue;
    const g = group(l.cause).log, r = records.get(l.id), k = root(l.id);
    g.roots.set(k, Math.max(g.roots.get(k) ?? 0, labels.get(k).occurrences ?? 1));
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
  const proposals = readJsonl(pf, false).map((p) => {
    const refs = Array.isArray(p.refs) ? p.refs : [];
    const missing = refs.filter((ref) => !records.has(ref) && !rows.some((r) => `${r.source}:${r.id}` === ref));
    const bad = !groups[p.cause] ? `cause ${p.cause} has no counted events` : !refs.length ? 'no evidence refs' : missing.length ? `refs not found: ${missing.join(', ')}` : !p.change ? 'no change text' : '';
    if (bad) problems.push(`${basename(pf)}:${p._line}: ${bad}`);
    return { ...p, refs, ok: !bad };
  });
  return { cfg, meta, records, rows, labels, groups: list, proposals, problems, unlabelled: [...records.keys()].filter((id) => !labels.has(id)).length };
}

function count(a) {
  const pad = (s, n) => String(s).padEnd(n), w = Math.max(5, ...a.groups.map((g) => g.cause.length)) + 2;
  console.log(`${pad('cause', w)}${pad('log incidents', 22)}${pad('store rows', 16)}repeated`);
  for (const g of a.groups) console.log(pad(g.cause, w) + pad(g.incidents ? `${g.incidents} (${g.log.records.length} rec, ${g.log.days.size} d)` : '-', 22) +
    pad(g.store.rows.length ? `${g.store.rows.length} (${g.store.days.size} d)` : '-', 16) + (g.repeated ? `yes (${g.by.join(', ')})` : 'no'));
  console.log(`\nlabelled ${a.labels.size} of ${a.records.size} log records; ${a.unlabelled} unlabelled and not counted`);
  console.log(`log and store counts are never added: they share no incident id`);
  for (const p of a.problems) console.log(`problem: ${p}`);
}

function report(a) {
  const src = new Map(a.meta.sources.map((s) => [s.id, s]));
  const ref = (id) => { const r = a.records.get(id); return r ? `${basename(src.get(r.source)?.path ?? r.source)}:${r.line}` : id; };
  const o = [`# Repeated causes: ${a.cfg.name}`, '', `Sources read ${a.meta.read_at} (read-only):`, ''];
  for (const s of a.meta.sources) o.push(`- \`${s.id}\` ${s.type}, ${s.items} items, ${s.hash.startsWith('mtime') ? s.hash : `sha256 ${s.hash}`}`);
  o.push('', `Repeated means at least ${a.cfg.repeat.min_incidents} incidents on at least ${a.cfg.repeat.min_days} days within one source. Log and store counts are shown side by side and never added.`,
    `Coverage: ${a.labels.size} of ${a.records.size} log records labelled by an agent; **${a.unlabelled} unlabelled records were not analysed.**`);
  for (const g of a.groups) {
    o.push('', `## ${g.cause}: ${g.repeated ? `repeated (${g.by.join(', ')})` : 'not repeated'}`, '', g.description, '',
      `- Log (agent-judged): ${g.incidents} incidents in ${g.log.records.length} records over ${g.log.days.size} day${g.log.days.size === 1 ? '' : 's'}`);
    const m = a.cfg.causes[g.cause]?.match;
    if (m) o.push(`- Store (typed rows where \`${m.source}\` error contains "${m.error_contains}"): ${g.store.rows.length} failed steps over ${g.store.days.size} day${g.store.days.size === 1 ? '' : 's'}`);
    for (const r of g.log.records) {
      const l = r.label, notes = [l.duplicate_of && `same incident as ${ref(l.duplicate_of)}`, l.occurrences > 1 && `${l.occurrences} occurrences`, l.confidence && `${l.confidence} confidence`].filter(Boolean);
      o.push(`  - ${ref(r.id)} (${r.date || 'no date'}): ${l.why}${notes.length ? ` [${notes.join('; ')}]` : ''}`);
    }
    for (const r of g.store.rows) o.push(`  - ${r.source}:${r.id} ${r.at} ${r.step} on ${r.branch}`);
    const ps = a.proposals.filter((p) => p.cause === g.cause);
    if (ps.length) o.push('', 'Recommended changes (not applied):');
    for (const p of ps) o.push(`- ${p.ok ? '' : '**evidence not checked:** '}${p.target ?? 'target?'} (${p.owner ?? 'owner?'}): ${p.change}`, `  evidence: ${p.refs.map(ref).join(', ') || 'none'}`);
  }
  if (a.problems.length) o.push('', '## Problems', '', ...a.problems.map((p) => `- ${p}`));
  console.log(o.join('\n'));
}

const USAGE = `usage: lfm <ingest|count|report> [--dir <project dir>] [--labels <file>] [--proposals <file>]
  ingest  read the configured sources (read-only) into the state dir
  count   count repeated causes from labels.jsonl and typed store rows
  report  print a Markdown report with evidence and recommended changes
labels.jsonl and proposals.jsonl default to the state dir, where the agent writes them`;
try {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--dir', '--labels', '--proposals'].includes(rest[i]) || !rest[i + 1]) throw new UsageError(USAGE);
    opts[rest[i].slice(2)] = resolve(rest[i + 1]);
  }
  if (!['ingest', 'count', 'report'].includes(cmd)) throw new UsageError(USAGE);
  const cfg = loadConfig(opts.dir ?? resolve('.'));
  if (cmd === 'ingest') ingest(cfg);
  else {
    const a = analyse(cfg, opts);
    if (!a.records.size && !a.rows.length) { console.log('no records or rows in the sources: nothing to count'); process.exit(3); }
    (cmd === 'count' ? count : report)(a);
    if (a.problems.length) process.exit(1);
  }
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exit(2);
}
