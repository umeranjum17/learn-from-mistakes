// Where a task's time goes. A status line opens a stage that lasts until the next line of the same file; its state and
// text pick the stage. Working time is the one stage that makes progress: the others are waits, and the report ranks the
// waits. Each wait has the usual cause and the way of working that shortens it, written in the report's plain words.
export const STAGES = {
  queued: { metric: 'hours_queued', label: 'queued before a worker started',
    cause: 'Tasks wait for a free slot or for a worker to start.', fix: 'Start fewer tasks at once, and start the oldest task first.' },
  captain: { metric: 'hours_waiting_captain', label: 'waiting for the captain',
    cause: 'A worker stops until a person answers a question.', fix: 'Ask once with a default answer, and let the worker go on with the default.' },
  ci: { metric: 'hours_waiting_ci', label: 'waiting for CI',
    cause: 'A worker waits for slow or failing checks.', fix: 'Run the checks locally before the push, and fix the slowest job first.' },
  review: { metric: 'hours_in_review', label: 'in review',
    cause: 'A change waits for a reviewer, then waits again for each round.', fix: 'Keep each change small, and name the reviewer when the work starts.' },
  blocked: { metric: 'hours_blocked', label: 'blocked on something else',
    cause: 'A worker waits for a tool, a host or another task.', fix: 'Name the blocker in the first line, so the lead can clear it the same day.' },
  merge: { metric: 'hours_merge_wait', label: 'with the PR open until merged',
    cause: 'A finished PR waits for a merge call, and for CI and review on the PR.', fix: 'Give one owner the merge call, and merge on green without a second look.' },
};
export const WORKING = { metric: 'hours_working' };
export const STAGE_METRICS = [WORKING.metric, ...Object.values(STAGES).map((s) => s.metric), 'tasks_timed'];

// The stage a status line opens: null for a line that opens none (done, failed or a state the log does not define). A
// working line, or a resolved line that closes a wait, is work; a paused or blocked line is a wait, named by what its
// text waits for. A needs-decision line waits for the captain.
const WAITS = [['captain', /\b(captain|decision|approv\w*|answer|sign-?off|question)\b/i], ['ci', /\b(ci|checks?|pipeline|actions)\b/i],
  ['review', /\breview\w*/i], ['merge', /\bmerg\w*/i]];
export function stageOf(state, text) {
  if (state === 'working' || state === 'resolved') return 'working';
  if (state === 'queued') return 'queued';
  if (state === 'needs-decision') return 'captain';
  if (state === 'paused' || state === 'blocked') return WAITS.find(([, re]) => re.test(text))?.[0] ?? 'blocked';
  return null;
}
