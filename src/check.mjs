// The counting and the rules after the run's agent steps. `repeats` counts each cause from the labels: a duplicate is
// one incident with the record it repeats, a record with occurrences is that many, and a cause repeats when it has
// repeat.min_incidents incidents on repeat.min_days days, from the labels or from the items a match rule tagged; `other`
// never repeats. `counts` adds the findings: a finding's items are the events, cluster events and records its refs name.
// The check step keeps only the fixes that follow the rules, ranks them by how often their cause came back and how far
// their metric misses its target, and keeps the top five.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordId, UsageError } from '../bin/learn-from-mistakes-axi.mjs';
import { clusters } from './bundle.mjs';
import { isMetric, METRIC_RULE, RULE } from './config.mjs';
import { meets } from './metrics.mjs';

const MAX = 5;

// The ids a bundle cites: its clusters, events and records.
export const bundleIds = (text) => new Set([...text.matchAll(/^(?:### |- )\[([^\]\n]+)\]/gm)].map((m) => m[1]));

// The run's own evidence file, <run dir>/bundle.md, the one its agents read and its check step counts refs against.
// A missing or unreadable file names the file and the fix: it never fails a real claim as a ref to a bundle item
// that is not there, and never ends the run in a raw stack trace.
export function readBundle(dir, id) {
  const file = join(dir, 'bundle.md');
  try { return readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') throw new UsageError(`the run's bundle ${file} is missing, so its evidence cannot be checked`, `learn-from-mistakes-axi rerun --resume --run ${id}   # rebuild it by finishing the run's steps again`);
    throw new UsageError(`${file}: cannot read (${e.code})`, `chmod u+r ${file}   # the run's bundle`);
  }
}

// The STE100 length rule on one free-text field; '' when it holds.
export function plain(text, where, { words, sentences }) {
  if (typeof text !== 'string' || !text.trim()) return `${where} must be a non-empty string`;
  const parts = text.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s+/).filter((s) => s.trim()); // "e.g. the" does not end a sentence
  const long = parts.findIndex((s) => s.trim().split(/\s+/).length > 20);
  if (long >= 0) return `${where}: sentence ${long + 1} has more than 20 words`;
  if (words && text.trim().split(/\s+/).length > words) return `${where} has more than ${words} words`;
  if (sentences && parts.length > sentences) return `${where} has more than ${sentences} sentences`;
  return '';
}

// records: id -> { date }; labels: id -> label; rows: the items a match rule tagged ({ source, id, cause, at }).
export function repeats(cfg, records, labels, rows) {
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
    for (const row of rows) if (row.cause === cause && !labels.has(recordId(row))) {
      group(cause).store.rows.push(row);
      if (row.at) group(cause).store.days.add(row.at.slice(0, 10));
    }
  }
  const { min_incidents: mi, min_days: md } = cfg.repeat;
  return Object.values(groups).map((g) => {
    const incidents = [...g.log.roots.values()].reduce((a, b) => a + b, 0);
    const logRepeated = incidents >= mi && g.log.days.size >= md, storeRepeated = g.store.rows.length >= mi && g.store.days.size >= md;
    return { ...g, incidents, repeated: g.cause !== 'other' && (logRepeated || storeRepeated), by: [logRepeated && 'log', storeRepeated && 'store'].filter(Boolean) };
  }).sort((a, b) => b.repeated - a.repeated || Math.max(b.incidents, b.store.rows.length) - Math.max(a.incidents, a.store.rows.length));
}

// Each cause's incidents, days and whether it repeated, from this run's labels, tagged items and findings; and each
// finding's count and days. A finding the judge refuted is dropped: it counts nothing.
export function counts(cfg, db, id, { current_start }) {
  const recs = db.prepare('SELECT record_id, source, ts, cause FROM records WHERE run_id = ?').all(id);
  const evs = db.prepare('SELECT id, ts, cause FROM events WHERE run_id = ?').all(id);
  const records = new Map(recs.map((r) => [r.record_id, { date: r.ts?.slice(0, 10) }]));
  const labels = new Map(db.prepare('SELECT record_id, event, cause, duplicate_of, occurrences FROM labels WHERE run_id = ?').all(id)
    .map((l) => [l.record_id, { id: l.record_id, event: Boolean(l.event), cause: l.cause, duplicate_of: l.duplicate_of, occurrences: l.occurrences }]));
  const rows = [...recs.filter((r) => r.cause).map((r) => ({ source: r.source, id: r.record_id.slice(r.source.length + 1), cause: r.cause, at: r.ts })),
    ...evs.filter((e) => e.cause).map((e) => ({ source: 'sessions', id: `e${e.id}`, cause: e.cause, at: e.ts }))];
  const inBundle = clusters(db, id, Date.parse(current_start)).map(([, es]) => es);
  const dates = new Map([...evs.map((e) => [`e${e.id}`, e.ts?.slice(0, 10)]), ...[...records].map(([k, r]) => [k, r.date])]);
  const findings = db.prepare(`SELECT id, cause, refs_json FROM findings WHERE run_id = ? AND verdict IS NOT 'refuted' ORDER BY id`).all(id).map((f) => {
    const items = new Map();
    for (const ref of JSON.parse(f.refs_json)) {
      const c = /^c(\d+)$/.exec(ref)?.[1];
      for (const k of c ? (inBundle[c - 1] ?? []).map((e) => `e${e.id}`) : dates.has(ref) ? [ref] : []) items.set(k, dates.get(k));
    }
    return { id: f.id, cause: f.cause, count: items.size, days: new Set([...items.values()].filter(Boolean)).size };
  });
  const causes = new Map(repeats(cfg, records, labels, rows).map((g) => [g.cause,
    { count: Math.max(g.incidents, g.store.rows.length), days: Math.max(g.log.days.size, g.store.days.size), repeated: g.repeated }]));
  const { min_incidents: mi, min_days: md } = cfg.repeat;
  for (const f of findings) {
    const c = causes.get(f.cause) ?? { count: 0, days: 0, repeated: false };
    causes.set(f.cause, { count: Math.max(c.count, f.count), days: Math.max(c.days, f.days),
      repeated: c.repeated || (f.cause !== 'other' && f.count >= mi && f.days >= md) });
  }
  return { causes, findings };
}

// The check step. A fix is kept when the judge did not refute it, its cause has counted events and repeated, its refs
// name bundle items, it has a target, an owner, a metric (default cause_count:<cause>) and a tripwire; a fix that breaks
// a rule is a problem: it is logged and saved with the rule. The kept fixes are ranked, a fix the judge did not confirm
// (weakened, or not judged) after the others, and numbered 1 to 5 (proposals.n); one past five is a problem.
// It can run again: it first clears what it set.
export function check(cfg, db, id, dir, window, log) {
  const { causes, findings } = counts(cfg, db, id, window);
  const ids = bundleIds(readBundle(dir, id));
  // How far each metric this window misses its target; 0 when it meets it or has none.
  const gaps = new Map(db.prepare(`SELECT name, value, target FROM metrics WHERE run_id = ? AND window = 'current' AND target IS NOT NULL AND value IS NOT NULL`).all(id)
    .filter((m) => !meets(m.value, m.target)).map((m) => [m.name, Math.abs(m.value - Number(RULE.exec(m.target)[2]))]));
  const fixes = db.prepare('SELECT id, cause, target, owner, metric, tripwire, refs_json, verdict FROM proposals WHERE run_id = ? ORDER BY id').all(id).map((f, i) => {
    const refs = JSON.parse(f.refs_json), missing = refs.filter((r) => !ids.has(r)).length, c = causes.get(f.cause);
    const metric = f.metric?.trim() || `cause_count:${f.cause}`, trip = RULE.exec(f.tripwire?.trim() ?? '');
    const bad = f.verdict === 'refuted' ? 'the judge refuted it' : !c?.count ? 'its cause has no counted events'
      : !refs.length ? 'no evidence refs' : missing ? `${missing} of ${refs.length} refs name no bundle item`
      : !c.repeated ? 'its cause did not repeat; propose only for repeated causes'
      : !f.target.trim() ? 'no target' : !f.owner.trim() ? 'no owner'
      : !isMetric(metric, cfg.causes) ? `its metric is not ${METRIC_RULE}`
      : !f.tripwire?.trim() ? 'no tripwire' : !trip ? 'its tripwire is not "<op> <number>", such as "<= 0"' : '';
    return { id: f.id, i, metric, tripwire: trip ? `${trip[1]} ${trip[2]}` : f.tripwire, count: c?.count ?? 0, gap: gaps.get(metric) ?? 0, unconfirmed: f.verdict !== 'confirmed', bad };
  });
  const kept = fixes.filter((f) => !f.bad).sort((a, b) => a.unconfirmed - b.unconfirmed || b.count - a.count || b.gap - a.gap || a.i - b.i);
  for (const f of kept.slice(MAX)) f.bad = `more than ${MAX} fixes: ranked below the top ${MAX}`;
  const set = db.prepare('UPDATE proposals SET n = ?, metric = ?, tripwire = ?, problem = ? WHERE id = ?');
  const found = db.prepare('UPDATE findings SET count = ?, days = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE findings SET count = NULL, days = NULL WHERE run_id = ?').run(id);
    for (const f of fixes) set.run(f.bad ? null : kept.indexOf(f) + 1, f.metric, f.tripwire, f.bad || null, f.id);
    for (const f of findings) found.run(f.count, f.days, f.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const problems = fixes.filter((f) => f.bad);
  for (const f of problems) log(`problem: proposals[${f.i}]: ${f.bad}`);
  log(`fixes: ${fixes.length - problems.length} kept of ${fixes.length}, problems: ${problems.length}`);
  return { fixes: fixes.length, kept: fixes.length - problems.length, problems: problems.length };
}
