// The analyse step: the worker reads the bundle, names the causes and hidden problems it finds (`findings`, each with
// refs to bundle items, a 5-whys chain to the root cause and the cost) and labels each defect record in it by the v1 label rules (`labels`). The answer's shape and its
// free text (STE100: short sentences, plain words, active voice) are checked, and a bad answer is sent back once. A label or a ref that
// names no bundle item is a problem: it is counted and logged, and the label or finding that holds it is not kept.
// A finding with no why chain or cost, or with wording that blames a person or an agent, is not kept either. A finding whose wording only
// breaks the style rules is kept: the miss is logged and counted (`findings_style`) for the report's Not checked.
// A bundle with no cluster, event or record to cite asks the worker nothing.
import { readFileSync } from 'node:fs';
import { bundleIds, bundleParts, methodProblems, plain, readBundle, styleProblems } from '../check.mjs';
import { redact } from '../redact.mjs';
import { agentStep } from './agent-step.mjs';

const PROMPT = readFileSync(new URL('../prompts/analyse.md', import.meta.url), 'utf8');
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONFIDENCE = ['high', 'medium', 'low'];

function check(cfg, v, attempt = 1) {
  const p = [];
  if (!Array.isArray(v.findings)) p.push('findings must be a list');
  if (!Array.isArray(v.labels)) p.push('labels must be a list');
  if (p.length) return p;
  v.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object') return p.push(`${at} must be an object`);
    if (typeof f.cause !== 'string' || !(Object.hasOwn(cfg.causes, f.cause) || KEY.test(f.cause))) p.push(`${at}.cause must be a configured cause key or a new key: lowercase letters, digits and dashes`);
    if (attempt < 2) p.push(...methodProblems(f, at), ...styleProblems(f, at));
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
    if (l.cause != null && typeof l.cause !== 'string') p.push(`${at}.cause must be a string`);
    if (l.event && !(typeof l.cause === 'string' && (Object.hasOwn(cfg.causes, l.cause) || l.cause === 'other'))) p.push(`${at}.cause must be a listed cause or other`);
    if (attempt < 2) p.push(plain(l.why, `${at}.why`, { words: 25 })); // the last answer keeps its labels; one with a bad why is dropped below, not the whole run
    if (l.duplicate_of != null && typeof l.duplicate_of !== 'string') p.push(`${at}.duplicate_of must be a record id`);
    if (l.occurrences != null && !(Number.isInteger(l.occurrences) && l.occurrences > 0)) p.push(`${at}.occurrences must be a positive integer`);
    if (l.confidence != null && !CONFIDENCE.includes(l.confidence)) p.push(`${at}.confidence must be high, medium or low`);
  });
  return p.filter(Boolean);
}

export async function analyse(cfg, db, id, dir, log) {
  db.prepare('DELETE FROM labels WHERE run_id = ?').run(id); // a step run again starts empty
  db.prepare('DELETE FROM findings WHERE run_id = ?').run(id);
  const bundle = readBundle(dir, id), ids = bundleIds(bundle);
  if (!ids.size) {
    log('nothing to analyse: the bundle has no signal cluster and no unlabelled record');
    return { asked: false, labels: 0, labels_dropped: 0, findings: 0, findings_style: 0, problems: 0 };
  }
  const records = new Set(db.prepare('SELECT record_id FROM records WHERE run_id = ?').all(id).map((r) => r.record_id).filter((r) => ids.has(r)));
  const causes = [...Object.entries(cfg.causes).map(([k, c]) => `- ${k}: ${c.description}`), '- other: a real failure that no listed cause names.'].join('\n');
  // The worker reads the bundle one part at a time, so every item reaches it; its answers are joined.
  const v = { findings: [], labels: [] };
  for (const text of bundleParts(bundle).filter((part) => bundleIds(part).size)) { // a part with only metrics has nothing to cite
    const part = await agentStep(cfg, db, id, dir, { step: 'analyse', role: 'worker', prompt: PROMPT.replace('{{causes}}', () => causes), check: (x, attempt) => check(cfg, x, attempt), log, text });
    v.findings.push(...part.findings);
    v.labels.push(...part.labels);
  }
  const problems = [];
  let findingsStyle = 0;
  const findings = v.findings.filter((f, i) => {
    const method = methodProblems(f, `findings[${i}]`); // the retro method: a finding without its why chain, cost and blameless wording is not kept
    if (method.length) { problems.push(...method); return false; }
    const bad = f.refs.findIndex((r) => !ids.has(r));
    if (bad >= 0) { problems.push(`findings[${i}]: ref ${bad + 1} names no bundle item`); return false; }
    const style = styleProblems(f, `findings[${i}]`);
    if (style.length) { problems.push(...style); findingsStyle++; }
    return true;
  });
  const labelled = new Set(); // one label for a record: a part's answer may label a record that another part holds
  const labels = v.labels.filter((l, i) => {
    const bad = labelled.has(l.id) ? 'is a second label for one record' : plain(l.why, '', { words: 25 }) ? 'has a why that breaks the plain-language rules' : !records.has(l.id) ? 'names no defect record in the bundle' : l.duplicate_of != null && !records.has(l.duplicate_of) ? 'duplicate_of names no defect record in the bundle' : '';
    if (bad) problems.push(`labels[${i}] ${bad}`);
    else labelled.add(l.id);
    return !bad;
  });
  const label = db.prepare('INSERT INTO labels (run_id, record_id, event, cause, why, duplicate_of, occurrences, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const finding = db.prepare('INSERT INTO findings (run_id, cause, summary, refs_json, whys_json, cost) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const l of labels) label.run(id, l.id, l.event ? 1 : 0, l.cause ?? null, l.why.trim(), l.duplicate_of ?? null, l.occurrences ?? null, l.confidence ?? null);
    const clean = (t) => redact(t).replace(/\s+/g, ' ').trim();
    for (const f of findings) finding.run(id, f.cause, clean(f.summary), JSON.stringify(f.refs), JSON.stringify(f.whys.map(clean)), clean(f.cost));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const dropped = v.labels.length - labels.length;
  for (const p of problems) log(`problem: ${p}`);
  log(`labels: ${labels.length} of ${records.size} records, ${dropped} dropped, findings: ${findings.length}, problems: ${problems.length}`);
  return { asked: true, labels: labels.length, labels_dropped: dropped, findings: findings.length, findings_style: findingsStyle, problems: problems.length };
}
