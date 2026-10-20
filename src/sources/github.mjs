// github: the pull requests merged in the read range, from the GitHub repo the project's `origin` names,
// read through the user's own `gh` login (`gh api graphql`, read-only, one query paged newest first). Each PR is one
// record: its title and body (redacted; empty with `excerpts: off`), with the facts its metrics count in `data`. A later
// merged PR whose title starts with "Revert" (Reverts, Reverted) and names #N reverts PR N; a later merged PR whose title
// starts with "fix" (fix:, fix(scope):, Fixes, Fixed) and names #N is an escape from it.
// A PR with more than 100 commits is read from its first 100 and marked partial.
// The repo's GitHub Actions runs created in the read range are read through the REST API, one record each (data.kind
// "ci", kept apart from the PRs so the agents never see them): its workflow, conclusion, attempts, and for a run that failed or was rerun, the jobs that failed in its last
// attempt and the flaky ones (failed in an earlier attempt, passed in the last). Job names are read for the newest
// JOB_RUNS such runs. A repo whose runs cannot be read keeps its PR numbers and says so (the source's `missing`).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { shq, UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { mapping, PROJECT_FILE } from '../config.mjs';
import { inWindow } from '../metrics.mjs';
import { redact } from '../redact.mjs';
import { which } from '../runners/index.mjs';

const QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED], first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title body author { __typename login } createdAt updatedAt mergedAt
        labels(first: 20) { nodes { name } } reviews(first: 50) { nodes { state } }
        commits(first: 100) { totalCount nodes { commit { authoredDate parents { totalCount } statusCheckRollup { state } } } } }
    }
  }
}`;

const JOB_RUNS = 200;
const FAILED = ['failure', 'timed_out', 'startup_failure'], DONE = ['success', ...FAILED]; // a cancelled, skipped or neutral run is neither
const lines = (p) => p.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));

export const validate = (s, where, dir) => ({ ...mapping(s, ['type'], where), dir });

// The host, owner and name of a GitHub `origin` (https, ssh or scp form); undefined for any other remote. The URL
// itself is never shown: it can hold a token.
function repo(dir) {
  const git = which('git');
  const url = git && spawnSync(git, ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim();
  const m = url?.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m && /(^|\.)github\./i.test(m[1]) ? { host: m[1].replace(/^ssh\.github\.com$/i, 'github.com'), owner: m[2], name: m[3] } : undefined;
}

const gh = (bin, { host }, args) => spawnSync(bin, [...args, ...(host === 'github.com' ? [] : ['--hostname', host])],
  { encoding: 'utf8', maxBuffer: 256 << 20, timeout: 120_000 });
const loggedOut = (p) => p.status === 4 || /gh auth login|not logged in/i.test(p.stderr ?? '');

// init: a github source when `origin` is a GitHub repo and gh is logged in to its host.
export function detect(dir) {
  const r = repo(dir);
  if (!r) return;
  const bin = which('gh');
  if (!bin) throw new Error('origin is on GitHub, but gh is not on PATH: install the GitHub CLI, then gh auth login');
  if (gh(bin, r, ['auth', 'status']).status !== 0) throw new Error(`origin is on GitHub, but gh is not logged in to ${r.host}: gh auth login`);
  return { prs: { type: 'github' } };
}

export async function read(source, { dir }, { readFrom = 0, excerpts = true, project = PROJECT_FILE } = {}) {
  const fail = (why, fix) => { throw new UsageError(`source ${source}: ${why}`, `remove sources.${source} from ${shq(project)}, or ${fix}`); };
  const r = repo(dir);
  if (!r) fail(`the project's git origin is not a GitHub repo`, 'git remote add origin https://github.com/<owner>/<repo>');
  const bin = which('gh');
  if (!bin) fail('gh is not on PATH', 'install the GitHub CLI (https://cli.github.com), then gh auth login');
  const nodes = new Map(); // by number: a PR updated between two page reads moves up and comes back on the next page
  for (let after = null; ;) {
    const p = gh(bin, r, ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${r.owner}`, '-f', `name=${r.name}`, ...(after ? ['-f', `after=${after}`] : [])]);
    if (p.error || p.status !== 0) {
      if (loggedOut(p)) fail(`gh is not logged in to ${r.host}`, `log in: gh auth login --hostname ${r.host}`);
      fail(`gh api graphql failed for ${r.owner}/${r.name} (${p.error?.code ?? (redact(p.stderr.trim().split('\n')[0]) || `exit ${p.status}`)})`, 'check gh auth status and the repo name');
    }
    let page;
    try { page = JSON.parse(p.stdout).data.repository.pullRequests; } catch { fail(`gh api graphql gave no pull requests for ${r.owner}/${r.name}`, 'check gh auth status and the repo name'); }
    for (const n of page.nodes) nodes.set(n.number, n);
    // Newest update first: a PR merged in the range was updated in it, so an older update ends the read.
    if (!page.pageInfo.hasNextPage || !page.nodes.length || Date.parse(page.nodes.at(-1).updatedAt) < readFrom) break;
    after = page.pageInfo.endCursor;
  }
  const merged = [...nodes.values()].filter((n) => Date.parse(n.mergedAt) >= readFrom);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = (n, number) => new RegExp(`(?:^|[^\\w/.-])(?:${esc(r.owner)}/${esc(r.name)})?#${number}(?!\\d)`, 'i').test(`${n.title}\n${n.body}`);
  const later = (title, n) => merged.some((m) => title.test(m.title) && m.mergedAt > n.mergedAt && names(m, n.number));
  const rows = merged.map((n) => {
    const commits = n.commits.nodes.map((c) => c.commit), opened = Date.parse(n.createdAt);
    // A commit after the PR opened is rework; it is CI rework when the commit before it had failing checks.
    const own = commits.filter((c) => c.parents.totalCount < 2);
    const rework = own.map((c, i) => Date.parse(c.authoredDate) > opened && (['FAILURE', 'ERROR'].includes(own[i - 1]?.statusCheckRollup?.state) ? 'ci' : 'other'));
    return { source, id: n.number, ts: n.mergedAt, ref: `PR #${n.number}`, text: excerpts ? redact(`${n.title}\n\n${n.body ?? ''}`.trim()) : '', data: {
      bot: n.author?.__typename === 'Bot', hours: (Date.parse(n.mergedAt) - opened) / 3_600_000,
      rework_ci: rework.filter((x) => x === 'ci').length, rework_other: rework.filter((x) => x === 'other').length,
      reverted: later(/^revert(s|ed)?\b/i, n), escaped: later(/^fix(es|ed)?\b/i, n),
      partial: n.commits.totalCount > commits.length, labels: n.labels.nodes.map((l) => l.name),
      changes_requested: n.reviews.nodes.filter((v) => v.state === 'CHANGES_REQUESTED').length } };
  });
  const ci = readRuns(bin, r, source, readFrom);
  return { prs: rows, ci: ci.rows, ...(ci.missing.length && { missing: ci.missing }), hash: createHash('sha256').update(JSON.stringify([rows, ci.rows])).digest('hex') };
}

// The Actions runs created since `readFrom`, as records; `missing` names what could not be read. GitHub lists at most 1000 runs a search.
function readRuns(bin, r, source, readFrom) {
  const base = `repos/${r.owner}/${r.name}/actions/runs`, repoName = `${r.owner}/${r.name}`;
  const created = encodeURIComponent(`>=${new Date(readFrom).toISOString().slice(0, 19)}Z`);
  const listed = gh(bin, r, ['api', '--paginate', `${base}?per_page=100&created=${created}`, '--jq', '.workflow_runs[] | {id, name, conclusion, run_attempt, created_at} | tojson']);
  if (listed.error || listed.status !== 0) return { rows: [], missing: [`GitHub Actions runs of ${repoName} (${listed.error?.code ?? (redact((listed.stderr ?? '').trim().split('\n')[0]) || `exit ${listed.status}`)})`] };
  let runs;
  try { runs = lines(listed); if (!runs.every((x) => x.id && x.created_at)) throw new Error('shape'); } catch { return { rows: [], missing: [`GitHub Actions runs of ${repoName} (gh gave no run list)`] }; }
  const jobs = (run, attempt) => {
    const p = gh(bin, r, ['api', `${base}/${run}/attempts/${attempt}/jobs?per_page=100`, '--jq', '.jobs[] | {name, conclusion} | tojson']);
    try { return p.status === 0 ? lines(p) : undefined; } catch { return undefined; }
  };
  const wanted = runs.filter((x) => FAILED.includes(x.conclusion) || x.run_attempt > 1).sort((a, b) => b.created_at.localeCompare(a.created_at)), need = wanted.slice(0, JOB_RUNS);
  const detail = new Map(need.map((x) => {
    const tries = Array.from({ length: x.run_attempt }, (_, i) => jobs(x.id, i + 1));
    if (tries.some((t) => !t)) return [x.id, undefined];
    const last = new Set(tries.at(-1).filter((j) => FAILED.includes(j.conclusion)).map((j) => j.name));
    const passed = new Set(tries.at(-1).filter((j) => j.conclusion === 'success').map((j) => j.name));
    const earlier = new Set(tries.slice(0, -1).flat().filter((j) => FAILED.includes(j.conclusion) && passed.has(j.name)).map((j) => j.name));
    return [x.id, { failed_jobs: [...last], flaky_jobs: [...earlier] }];
  }));
  const rows = runs.map((x) => ({ source, id: `run:${x.id}`, ts: x.created_at, ref: `Actions run ${x.id}`, text: '', data: {
    kind: 'ci', repo: repoName, workflow: x.name, conclusion: x.conclusion, attempts: x.run_attempt, ...detail.get(x.id) } }));
  const unread = wanted.length - need.length + [...detail.values()].filter((d) => !d).length;
  return { rows, missing: unread ? [`job names of ${unread} failed or rerun Actions runs of ${repoName} (only the newest ${JOB_RUNS} are read)`] : [] };
}

// doctor: readable, the PRs merged in the window, the partial ones (over 100 commits), and the Actions runs.
export async function doctor(source, entry, ctx) {
  const { prs: merged, ci, missing } = await read(source, entry, ctx);
  return { level: 'ok', detail: `${merged.length} PRs merged in the window, ${merged.filter((r) => r.data.partial).length} partial (over 100 commits), ${ci.length} Actions runs${missing ? `; not read: ${missing.join('; ')}` : ''}` };
}

// The numbers over the PRs merged in the window. first_pass is the share of merged PRs by people (not bots) with no
// commit after open that were not reverted or escaped; hours_to_merge is from open to merge, nearest rank; rework_per_merge
// is the rework commits a merged PR. The Actions runs created in the window give ci_runs (finished runs, not cancelled or
// skipped), ci_failure_rate (the share of them that failed), ci_reruns (runs with a second attempt), ci_flaky_jobs (jobs that
// failed, then passed on a rerun of the same run), and ci_failure_rate:<repo> and ci_job_failures:<repo> / <workflow> / <job>
// for each repo and job that failed in either window, so a job that stopped failing shows 0, not n/a.
export const metricNames = ['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'rework_per_merge', 'reverted', 'escaped',
  'ci_runs', 'ci_failure_rate', 'ci_reruns', 'ci_flaky_jobs'];
export const metricRows = 'records';
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const share = (part, whole) => (whole ? round((100 * part) / whole, 1) : null);
export function metrics(rows, window) {
  const data = rows.map((r) => ({ r, d: JSON.parse(r.data) })), ci = data.filter(({ d }) => d.kind === 'ci');
  const prs = inWindow(data.filter(({ d }) => d.kind !== 'ci').map(({ r }) => r), window).map((r) => JSON.parse(r.data));
  const people = prs.filter((d) => !d.bot), hours = prs.map((d) => d.hours).sort((a, b) => a - b);
  const rank = (p) => (hours.length ? round(hours[Math.ceil(p * hours.length) - 1], 2) : null);
  const sum = (f) => (prs.length ? prs.reduce((n, d) => n + Number(f(d)), 0) : null);
  const first = people.filter((d) => !d.rework_ci && !d.rework_other && !d.reverted && !d.escaped).length;
  const runs = inWindow(ci.map(({ r }) => r), window).map((r) => JSON.parse(r.data)).filter((d) => DONE.includes(d.conclusion));
  const failed = (list) => list.filter((d) => FAILED.includes(d.conclusion));
  const jobKey = (d, job) => `${d.repo} / ${d.workflow} / ${job}`;
  const jobs = new Map(), repos = new Set();
  for (const { d } of ci) {
    repos.add(d.repo);
    for (const j of d.failed_jobs ?? []) jobs.set(jobKey(d, j), 0);
  }
  for (const d of failed(runs)) for (const j of d.failed_jobs ?? []) jobs.set(jobKey(d, j), jobs.get(jobKey(d, j)) + 1);
  const rework = sum((d) => d.rework_ci + d.rework_other);
  return {
    merged: prs.length, first_pass: share(first, people.length),
    p50_hours_to_merge: rank(0.5), p90_hours_to_merge: rank(0.9),
    rework_ci: sum((d) => d.rework_ci), rework_other: sum((d) => d.rework_other), rework_per_merge: rework === null ? null : rework / prs.length,
    reverted: sum((d) => d.reverted), escaped: sum((d) => d.escaped),
    ci_runs: ci.length ? runs.length : null, ci_failure_rate: share(failed(runs).length, runs.length),
    ci_reruns: ci.length ? runs.filter((d) => d.attempts > 1).length : null, ci_flaky_jobs: ci.length ? runs.reduce((n, d) => n + (d.flaky_jobs?.length ?? 0), 0) : null,
    ...Object.fromEntries([...repos].map((repo) => [`ci_failure_rate:${repo}`, share(failed(runs.filter((d) => d.repo === repo)).length, runs.filter((d) => d.repo === repo).length)])),
    ...Object.fromEntries([...jobs].map(([k, n]) => [`ci_job_failures:${k}`, n])),
  };
}
