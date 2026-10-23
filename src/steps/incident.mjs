// The agent steps of an incident run, each through agentStep like a retro's: timeline (what happened, in order), causes
// (the root causes, each a 5-whys chain, saved as findings so the verify step judges them), gates (each check that did
// not catch it), prevent (how to avoid it now, and the fixes, saved as proposals so verify-fixes judges them) and check
// (numbers the fixes that keep the rules). Each answer's shape, its free text (STE100) and its refs (each names a bundle
// item) are checked, and a bad answer is sent back once. The second answer keeps only the entries that hold; a fix that
// breaks a rule is saved with the rule it broke, so the report names it.
import { readFileSync } from 'node:fs';
import { bundleIds, methodProblems, plain, quoteProblem, quoteRuns, rawProblem, readBundle, styleProblems } from '../check.mjs';
import { readContext } from '../context.mjs';
import { redact } from '../redact.mjs';
import { agentStep } from './agent-step.mjs';

const prompt = (name) => readFileSync(new URL(`../prompts/incident-${name}.md`, import.meta.url), 'utf8');
const PROMPTS = { timeline: prompt('timeline'), causes: prompt('causes'), gates: prompt('gates'), prevent: prompt('prevent') };
const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AT = /^(?:unknown|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]{2,15}(?:Z|[+-]\d{2}:?\d{2})?)?)$/;
const PRIORITY = ['P0', 'P1', 'P2', 'P3'];
const str = (v) => typeof v === 'string' && v.trim() !== '';
const clean = (t) => redact(t).replace(/\s+/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);

// The refs rule every entry keeps: a non-empty list of ids, each a bundle item.
function refsProblem(refs, at, ids) {
  if (!Array.isArray(refs) || !refs.length || !refs.every((r) => typeof r === 'string')) return `${at}.refs must be a non-empty list of bundle ids`;
  const bad = refs.findIndex((r) => !ids.has(r));
  return bad < 0 ? '' : `${at}.refs: ref ${bad + 1} names no bundle item`;
}

// One list answer: the first attempt must hold whole; the second keeps the entries that hold (`problems` names each).
// `more` names the problems of the answer's other fields, sent back with the list's on the first attempt.
async function ask(cfg, db, id, dir, log, { step, key, fill = {}, rules, max, more = () => [] }) {
  const ids = bundleIds(readBundle(dir, id));
  const text = PROMPTS[step].replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k]);
  const sift = (v) => {
    const bad = [], kept = v[key].slice(0, max).filter((e, i) => {
      const p = !e || typeof e !== 'object' ? [`${key}[${i}] must be an object`] : rules(e, `${key}[${i}]`, ids).filter(Boolean);
      bad.push(...p);
      return !p.length;
    });
    return { kept, bad };
  };
  const answer = await agentStep(cfg, db, id, dir, { step, role: 'worker', prompt: text, log,
    check: (v, attempt) => (!Array.isArray(v[key]) ? [`${key} must be a list`] : attempt > 1 ? [] : [...(!v[key].length ? [`${key} must hold at least one entry`]
      : [...(v[key].length > max ? [`${key} has more than ${max} entries`] : []), ...sift(v).bad]), ...more(v)]) });
  const { kept, bad } = sift(answer);
  if (bad.length) log(`dropped: ${bad.join('; ')}`);
  return { answer, kept, bad };
}

function saveLines(db, id, step, entries) {
  db.prepare('DELETE FROM incident_lines WHERE run_id = ? AND step = ?').run(id, step);
  const add = db.prepare('INSERT INTO incident_lines (run_id, step, n, head, text, refs_json) VALUES (?, ?, ?, ?, ?, ?)');
  entries.forEach((e, i) => add.run(id, step, i + 1, e.head, e.text, JSON.stringify(e.refs)));
}
const listed = (rows, line) => (rows.length ? rows.map(line).join('\n') : 'None.');
const context = (cfg, db, id, dir) => {
  const ctx = JSON.parse(db.prepare(`SELECT output_json FROM steps WHERE run_id = ? AND name = 'context'`).get(id)?.output_json ?? '{}');
  return ctx && !ctx.off ? readContext(dir, id) : 'The project context is off for this project.';
};
const causesOf = (db, id) => db.prepare(`SELECT cause, summary, whys_json, verdict, refs_json FROM findings WHERE run_id = ? AND verdict IS NOT 'refuted' ORDER BY id`).all(id);
const causeLine = (c) => `- ${c.cause}${c.verdict ? `, ${c.verdict} by the judge` : ''}: ${c.summary} Root cause: ${JSON.parse(c.whys_json).at(-1)} Refs: ${JSON.parse(c.refs_json).join(', ')}.`;

export async function timeline(cfg, db, id, dir, log) {
  const { kept } = await ask(cfg, db, id, dir, log, { step: 'timeline', key: 'timeline', max: 15,
    rules: (e, at, ids) => [!(typeof e.at === 'string' && AT.test(e.at.trim())) && `${at}.at must be "unknown" or a date or ISO time`,
      plain(e.what, `${at}.what`, { words: 25, sentences: 1 }), str(e.what) && rawProblem(redact(e.what), `${at}.what`), refsProblem(e.refs, at, ids)] });
  saveLines(db, id, 'timeline', kept.map((e) => ({ head: e.at.trim(), text: clean(e.what), refs: e.refs })));
  log(`timeline: ${kept.length} entries`);
  return { entries: kept.length };
}

export async function causes(cfg, db, id, dir, log) {
  db.prepare('DELETE FROM findings WHERE run_id = ?').run(id);
  const fill = { timeline: listed(db.prepare(`SELECT head, text FROM incident_lines WHERE run_id = ? AND step = 'timeline' ORDER BY n`).all(id), (t) => `- ${t.head}: ${t.text}`),
    context: context(cfg, db, id, dir) };
  const { kept } = await ask(cfg, db, id, dir, log, { step: 'causes', key: 'causes', fill, max: 3,
    rules: (c, at, ids) => [!(typeof c.cause === 'string' && KEY.test(c.cause)) && `${at}.cause must be a key: lowercase letters, digits and dashes`,
      ...methodProblems(c, at), ...styleProblems(c, at), refsProblem(c.refs, at, ids)] });
  const add = db.prepare('INSERT INTO findings (run_id, cause, summary, refs_json, whys_json, cost) VALUES (?, ?, ?, ?, ?, ?)');
  for (const c of kept) add.run(id, c.cause, clean(c.summary), JSON.stringify(c.refs), JSON.stringify(c.whys.map(clean)), clean(c.cost));
  log(`causes: ${kept.length}`);
  return { causes: kept.length };
}

export async function gates(cfg, db, id, dir, log) {
  const { kept } = await ask(cfg, db, id, dir, log, { step: 'gates', key: 'gates', fill: { causes: listed(causesOf(db, id), causeLine), context: context(cfg, db, id, dir) }, max: 8,
    rules: (g, at, ids) => [plain(g.gate, `${at}.gate`, { words: 10, sentences: 1 }), plain(g.missed, `${at}.missed`, { sentences: 2 }),
      str(g.missed) && rawProblem(redact(g.missed), `${at}.missed`), refsProblem(g.refs, at, ids)] });
  saveLines(db, id, 'gates', kept.map((g) => ({ head: clean(g.gate), text: clean(g.missed), refs: g.refs })));
  log(`gates: ${kept.length}`);
  return { gates: kept.length };
}

// The rules a fix keeps: a root cause the judge did not refute, kind code or rule, an owning tool, a plain change, an
// owner, a priority, a due date on or after today, a check command, refs to bundle items, and for code the regression test.
export function fixProblems(f, at, ids, causes, runs) {
  const p = [];
  if (!causes.has(f.cause)) p.push(`${at}.cause must be one of the root causes: ${[...causes].join(', ') || 'none'}`);
  if (!['code', 'rule'].includes(f.kind)) p.push(`${at}.kind must be code or rule`);
  if (!str(f.target)) p.push(`${at}.target must name the owning tool`);
  if (!str(f.owner)) p.push(`${at}: no owner; the owner is the role that makes the change`);
  if (f.kind === 'code' && !str(f.test)) p.push(`${at}: no regression test; a code fix names the test that would have failed on this incident`);
  if (f.test != null && !(typeof f.test === 'string' && /^[^\p{Cc}\u2028\u2029]{0,300}$/u.test(f.test))) p.push(`${at}.test must be one line of at most 300 characters`);
  if (!PRIORITY.includes(f.priority)) p.push(`${at}.priority must be P0, P1, P2 or P3`);
  const due = typeof f.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.due) && !Number.isNaN(Date.parse(f.due)) && new Date(f.due).toISOString().slice(0, 10) === f.due;
  if (!f.due) p.push(`${at}: no due date; give the day it is due as YYYY-MM-DD`);
  else if (!due) p.push(`${at}.due must be a day as YYYY-MM-DD`);
  else if (f.due < today()) p.push(`${at}.due is before today`);
  if (!(str(f.check) && /^[^\p{Cc}\u2028\u2029]{1,200}$/u.test(f.check.trim()))) p.push(`${at}.check must be one command on one line, at most 200 characters, that passes once the fix is in`);
  p.push(plain(f.change, `${at}.change`, { sentences: 3 }));
  if (str(f.change)) p.push(rawProblem(redact(f.change), `${at}.change`));
  for (const k of ['target', 'owner', 'change']) if (str(f[k])) p.push(quoteProblem(f[k], `${at}.${k}`, runs));
  p.push(refsProblem(f.refs, at, ids));
  return p.filter(Boolean);
}

export async function prevent(cfg, db, id, dir, log) {
  db.prepare('DELETE FROM proposals WHERE run_id = ?').run(id);
  const kept = causesOf(db, id), keys = new Set(kept.map((c) => c.cause));
  const runs = quoteRuns(db.prepare('SELECT text FROM records WHERE run_id = ?').all(id).map((r) => r.text));
  if (!kept.length) { log('nothing to prevent: no root cause the judge kept'); return { asked: false, fixes: 0, avoid: [] }; }
  const fill = { causes: listed(kept, causeLine), today: today(), context: context(cfg, db, id, dir),
    gates: listed(db.prepare(`SELECT head, text FROM incident_lines WHERE run_id = ? AND step = 'gates' ORDER BY n`).all(id), (g) => `- ${g.head}: ${g.text}`) };
  // avoid: 1 to 3 strings of one plain sentence each. A bad first answer is sent back; the second keeps the ones that hold.
  const avoidProblems = (v) => (!Array.isArray(v.avoid) || !v.avoid.length || v.avoid.length > 3 ? ['avoid must be a list of 1 to 3 strings, each one sentence']
    : v.avoid.map((a, i) => plain(a, `avoid[${i}]`, { sentences: 1 }) || rawProblem(redact(a), `avoid[${i}]`)).filter(Boolean));
  const { answer } = await ask(cfg, db, id, dir, log, { step: 'prevent', key: 'fixes', fill, max: 5, rules: (f, at, ids) => fixProblems(f, at, ids, keys, runs), more: avoidProblems });
  // Every fix the worker gave is saved, in its order: one that breaks a rule keeps it as its problem and is never numbered.
  const ids = bundleIds(readBundle(dir, id));
  const add = db.prepare(`INSERT INTO proposals (run_id, cause, target, owner, change, refs_json, kind, check_cmd, test, priority, due, problem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  let refused = 0;
  answer.fixes.slice(0, 5).forEach((f, i) => {
    if (!f || typeof f !== 'object') return;
    const bad = fixProblems(f, `fixes[${i}]`, ids, keys, runs);
    if (bad.length) refused++;
    add.run(id, s(f.cause) || 'unnamed', s(f.target), s(f.owner), s(f.change), JSON.stringify(Array.isArray(f.refs) ? f.refs.filter((r) => typeof r === 'string') : []),
      s(f.kind) || null, s(f.check) ? redact(s(f.check)) : null, s(f.test) ? redact(s(f.test)) : null, s(f.priority) || null, s(f.due) || null,
      bad.length ? bad[0].replace(/^fixes\[\d+\][.:]?\s*/, '') : null);
  });
  const avoid = Array.isArray(answer.avoid) ? answer.avoid.slice(0, 3).filter((a, i) => !plain(a, '', { sentences: 1 }) && !rawProblem(redact(a), `avoid[${i}]`)).map(clean) : [];
  if (!avoid.length) log(`dropped: ${avoidProblems(answer).join('; ') || 'avoid'}`);
  log(`fixes: ${answer.fixes.length} given, ${refused} refused`);
  return { asked: true, fixes: answer.fixes.length, refused, avoid };
}

// Numbers the fixes that keep the rules and that the judge did not refute: P0 first, then the worker's order.
export function numberFixes(cfg, db, id, dir, log) {
  const rows = db.prepare('SELECT id, priority, verdict, problem FROM proposals WHERE run_id = ? ORDER BY id').all(id);
  const set = db.prepare('UPDATE proposals SET n = ?, problem = ? WHERE id = ?');
  const kept = [];
  for (const r of rows) {
    const bad = r.problem ?? (r.verdict === 'refuted' ? 'the judge refuted it' : !r.verdict ? 'the judge gave it no verdict' : null);
    set.run(null, bad, r.id);
    if (bad) log(`problem: ${bad}`);
    else kept.push(r);
  }
  kept.sort((a, b) => a.priority.localeCompare(b.priority) || a.id - b.id).forEach((r, i) => set.run(i + 1, null, r.id));
  log(`fixes: ${kept.length} kept of ${rows.length}`);
  return { fixes: rows.length, kept: kept.length };
}
