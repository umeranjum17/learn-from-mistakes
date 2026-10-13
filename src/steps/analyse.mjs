// The analyse step: the worker reads the bundle, names the causes and hidden problems it finds (`findings`, each with
// refs to bundle items) and labels each defect record in it by the v1 label rules (`labels`). The answer's shape and its
// free text (STE100: at most 20 words a sentence) are checked, and a bad answer is sent back once. A label or a ref that
// names no bundle item is a problem: it is counted and logged, and the label or finding that holds it is not kept.
// A bundle with no cluster, event or record to cite asks the worker nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../redact.mjs';
import { agentStep } from './agent-step.mjs';

const PROMPT = readFileSync(new URL('../prompts/analyse.md', import.meta.url), 'utf8');
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONFIDENCE = ['high', 'medium', 'low'];

// The STE100 length rule on one free-text field; '' when it holds.
function plain(text, where, { words, sentences }) {
  if (typeof text !== 'string' || !text.trim()) return `${where} must be a non-empty string`;
  const parts = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  const long = parts.findIndex((s) => s.trim().split(/\s+/).length > 20);
  if (long >= 0) return `${where}: sentence ${long + 1} has more than 20 words`;
  if (words && text.trim().split(/\s+/).length > words) return `${where} has more than ${words} words`;
  if (sentences && parts.length > sentences) return `${where} has more than ${sentences} sentences`;
  return '';
}

function check(cfg, v) {
  const p = [];
  if (!Array.isArray(v.findings)) p.push('findings must be a list');
  if (!Array.isArray(v.labels)) p.push('labels must be a list');
  if (p.length) return p;
  v.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object') return p.push(`${at} must be an object`);
    if (typeof f.cause !== 'string' || !KEY.test(f.cause)) p.push(`${at}.cause must be a cause key: lowercase letters, digits and dashes`);
    p.push(plain(f.summary, `${at}.summary`, { sentences: 3 }));
    if (!Array.isArray(f.refs) || !f.refs.length || !f.refs.every((r) => typeof r === 'string')) p.push(`${at}.refs must be a non-empty list of bundle ids`);
  });
  const seen = new Set();
  v.labels.forEach((l, i) => {
    const at = `labels[${i}]`;
    if (!l || typeof l !== 'object') return p.push(`${at} must be an object`);
    if (typeof l.id !== 'string') return p.push(`${at}.id must be a record id`);
    if (seen.has(l.id)) p.push(`${at} is a second label for one record`);
    seen.add(l.id);
    if (typeof l.event !== 'boolean') p.push(`${at}.event must be true or false`);
    if (l.event && !(typeof l.cause === 'string' && (Object.hasOwn(cfg.causes, l.cause) || l.cause === 'other'))) p.push(`${at}.cause must be a listed cause or other`);
    p.push(plain(l.why, `${at}.why`, { words: 25 }));
    if (l.duplicate_of !== undefined && typeof l.duplicate_of !== 'string') p.push(`${at}.duplicate_of must be a record id`);
    if (l.occurrences !== undefined && !(Number.isInteger(l.occurrences) && l.occurrences > 0)) p.push(`${at}.occurrences must be a positive integer`);
    if (l.confidence !== undefined && !CONFIDENCE.includes(l.confidence)) p.push(`${at}.confidence must be high, medium or low`);
  });
  return p.filter(Boolean);
}

export async function analyse(cfg, db, id, dir, log) {
  db.prepare('DELETE FROM labels WHERE run_id = ?').run(id); // a step run again starts empty
  db.prepare('DELETE FROM findings WHERE run_id = ?').run(id);
  const ids = new Set([...readFileSync(join(dir, 'bundle.md'), 'utf8').matchAll(/^(?:### |- )\[([^\]\n]+)\]/gm)].map((m) => m[1]));
  if (!ids.size) {
    log('nothing to analyse: the bundle has no signal cluster and no unlabelled record');
    return { labels: 0, findings: 0, problems: 0 };
  }
  // The bundle prints each record id redacted; the worker names it that way, and the labels table keeps the raw id.
  const records = new Map(db.prepare('SELECT record_id FROM records WHERE run_id = ?').all(id).map((r) => [redact(r.record_id), r.record_id]).filter(([shown]) => ids.has(shown)));
  const causes = [...Object.entries(cfg.causes).map(([k, c]) => `- ${k}: ${c.description}`), '- other: a real failure that no listed cause names.'].join('\n');
  const got = await agentStep(cfg, db, id, dir, { step: 'analyse', role: 'worker', prompt: PROMPT.replace('{{causes}}', () => causes), check: (x) => check(cfg, x), log });
  if (got.problem) {
    const warning = `no agent ready: ${got.problem}; run learn-from-mistakes-axi agents to see the agent CLIs found and the worker they resolve to; records stay unlabelled until an agent is ready or you label by hand`;
    log(warning);
    return { labels: 0, findings: 0, problems: 0, warning };
  }
  const v = got.value;
  const problems = [];
  const findings = v.findings.filter((f, i) => {
    const bad = f.refs.findIndex((r) => !ids.has(r));
    if (bad >= 0) problems.push(`findings[${i}]: ref ${bad + 1} names no bundle item`);
    return bad < 0;
  });
  const labels = v.labels.filter((l, i) => {
    const bad = !records.has(l.id) ? 'names no defect record in the bundle' : l.duplicate_of !== undefined && !records.has(l.duplicate_of) ? 'duplicate_of names no defect record in the bundle' : '';
    if (bad) problems.push(`labels[${i}] ${bad}`);
    return !bad;
  });
  const label = db.prepare('INSERT INTO labels (run_id, record_id, event, cause, why, duplicate_of, occurrences, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const finding = db.prepare('INSERT INTO findings (run_id, cause, summary, refs_json) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const l of labels) label.run(id, records.get(l.id), l.event ? 1 : 0, l.cause ?? null, l.why.trim(), records.get(l.duplicate_of) ?? null, l.occurrences ?? null, l.confidence ?? null);
    for (const f of findings) finding.run(id, f.cause, f.summary.trim(), JSON.stringify(f.refs));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const p of problems) log(`problem: ${p}`);
  log(`labels: ${labels.length} of ${records.size} records, findings: ${findings.length}, problems: ${problems.length}`);
  return { labels: labels.length, findings: findings.length, problems: problems.length };
}
