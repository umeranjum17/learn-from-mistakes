// run.v1: the one outside face of a run, shared by the three tools (id, stage, steps with status and times, loop counts,
// waits, result). This file is the single definition: the report builds and validates against it, and the docs diagram
// is generated from its MOVES table (`npm run build:diagram`). It carries identifiers, enum words, counts and times only:
// never an error text, a path, a record, a transcript or a project name.
export const RUN_STATUS = ['running', 'completed', 'failed', 'cancelled', 'interrupted'];
export const STEP_STATUS = ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
export const WAIT_KINDS = ['agent', 'signoff'];

// The run's moves: [event, from, to]. `start` has no source; `resume` is `rerun --resume` on a run that did not complete.
export const MOVES = [
  ['start', null, 'running'],
  ['finish', 'running', 'completed'],
  ['fail', 'running', 'failed'],
  ['abort', 'running', 'cancelled'],
  ['lose worker', 'running', 'interrupted'],
  ['resume', 'failed', 'running'],
  ['resume', 'cancelled', 'running'],
  ['resume', 'interrupted', 'running'],
];

// The life of a fix across runs, listed by `fixes`: the same [event, from, to] form. A fix is proposed by a run, kept
// when the user answers apply, applied when a change records it, shipped once it is live on the default branch, then
// worked (its check passed or its tripwire was met) or reverted (the default branch reverted it). Reverted wins over
// worked; a fix can be reverted from applied, shipped or worked.
export const FIX_STATES = ['proposed', 'kept', 'applied', 'shipped', 'worked', 'reverted'];
export const FIX_MOVES = [
  ['propose', null, 'proposed'],
  ['keep', 'proposed', 'kept'],
  ['record', 'proposed', 'applied'],
  ['record', 'kept', 'applied'],
  ['merge', 'applied', 'shipped'],
  ['check passes', 'shipped', 'worked'],
  ['revert', 'applied', 'reverted'],
  ['revert', 'shipped', 'reverted'],
  ['revert', 'worked', 'reverted'],
];

// The Mermaid stateDiagram of a moves table: the text docs/reference.md carries between its diagram markers.
export function diagram(moves = MOVES, finals = ['completed']) {
  return ['```mermaid', 'stateDiagram-v2',
    ...moves.map(([event, from, to]) => `    ${from ?? '[*]'} --> ${to}: ${event}`),
    ...finals.map((s) => `    ${s} --> [*]`), '```'].join('\n');
}

const iso = (v) => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
const count = (v) => Number.isInteger(v) && v >= 0;
const keys = (o, want) => o && typeof o === 'object' && Object.keys(o).sort().join() === [...want].sort().join();

// The first problem found, or '' for a valid run.v1 object.
export function validateRunV1(r) {
  if (!keys(r, ['schema', 'id', 'kind', 'status', 'stage', 'steps', 'loops', 'waits', 'result'])) return 'keys';
  if (r.schema !== 'run.v1' || !count(r.id) || !['retro', 'incident'].includes(r.kind) || !RUN_STATUS.includes(r.status)) return 'header';
  if (!Array.isArray(r.steps) || !r.steps.length || !r.steps.every((s) => keys(s, ['name', 'status', 'started_at', 'completed_at'])
    && typeof s.name === 'string' && STEP_STATUS.includes(s.status) && iso(s.started_at) && iso(s.completed_at))) return 'steps';
  if (r.stage !== 'done' && !r.steps.some((s) => s.name === r.stage)) return 'stage';
  if (!keys(r.loops, ['agent_calls', 'agent_retries']) || !count(r.loops.agent_calls) || !count(r.loops.agent_retries)) return 'loops';
  if (!Array.isArray(r.waits) || !r.waits.every((w) => keys(w, ['kind', 'since']) && WAIT_KINDS.includes(w.kind) && iso(w.since))) return 'waits';
  if (!keys(r.result, ['outcome', 'failed_step']) || !RUN_STATUS.includes(r.result.outcome) || !(r.result.failed_step === null || typeof r.result.failed_step === 'string')) return 'result';
  return '';
}

// The run.v1 object of a saved run, read from the store.
export function runV1(db, id) {
  const run = db.prepare('SELECT status, kind, updated_at FROM runs WHERE id = ?').get(id);
  const steps = db.prepare('SELECT name, status, started_at, completed_at FROM steps WHERE run_id = ? ORDER BY ord').all(id).map((s) => ({ ...s }));
  const open = steps.find((s) => s.status !== 'completed');
  const calls = db.prepare('SELECT step, completed_at FROM invocations WHERE run_id = ?').all(id);
  const perStep = Object.values(Object.groupBy(calls, (c) => c.step)).map((l) => l.length);
  const waits = [];
  const asking = calls.some((c) => c.completed_at === null) && steps.find((s) => s.status === 'running');
  if (asking) waits.push({ kind: 'agent', since: asking.started_at });
  const unanswered = db.prepare('SELECT count(*) AS n FROM signoff s JOIN proposals p ON p.id = s.proposal_id WHERE p.run_id = ? AND s.answer IS NULL').get(id).n;
  if (unanswered) waits.push({ kind: 'signoff', since: run.updated_at });
  return { schema: 'run.v1', id, kind: run.kind ?? 'retro', status: run.status, stage: open?.name ?? 'done', steps,
    loops: { agent_calls: calls.length, agent_retries: perStep.reduce((n, c) => n + c - 1, 0) }, waits,
    result: { outcome: run.status, failed_step: steps.find((s) => ['failed', 'cancelled', 'interrupted'].includes(s.status))?.name ?? null } };
}
