// github: the pull requests merged or closed in the read range, from the GitHub repo the project's `origin` names,
// read through the user's own `gh` login (`gh api graphql`, read-only, one query paged newest first). Each PR is one
// record: its title and body (redacted), with the facts its metrics count in `data`. A later merged PR titled
// "Revert" that names #N reverts PR N; a later merged PR whose title starts with "fix" and names #N is an escape from it.
// A PR with more than 100 commits is read from its first 100 and marked partial.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { UsageError } from '../../bin/learn-from-mistakes-axi.mjs';
import { mapping, PROJECT_FILE } from '../config.mjs';
import { inWindow } from '../metrics.mjs';
import { redact } from '../redact.mjs';
import { which } from '../runners/index.mjs';

const QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [MERGED, CLOSED], first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes { number title body author { __typename login } createdAt updatedAt mergedAt closedAt
        labels(first: 20) { nodes { name } } reviews(first: 50) { nodes { state } }
        commits(first: 100) { totalCount nodes { commit { authoredDate statusCheckRollup { state } } } } }
    }
  }
}`;

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
  return { type: 'github' };
}

export async function read(source, { dir }, { readFrom = 0 } = {}) {
  const fail = (why, fix) => { throw new UsageError(`source ${source}: ${why}`, `remove sources.${source} from ${PROJECT_FILE}, or ${fix}`); };
  const r = repo(dir);
  if (!r) fail(`the project's git origin is not a GitHub repo`, 'git remote add origin https://github.com/<owner>/<repo>');
  const bin = which('gh');
  if (!bin) fail('gh is not on PATH', 'install the GitHub CLI (https://cli.github.com), then gh auth login');
  const nodes = [];
  for (let after = null; ;) {
    const p = gh(bin, r, ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${r.owner}`, '-f', `name=${r.name}`, ...(after ? ['-f', `after=${after}`] : [])]);
    if (p.error || p.status !== 0) {
      if (loggedOut(p)) fail(`gh is not logged in to ${r.host}`, `log in: gh auth login --hostname ${r.host}`);
      fail(`gh api graphql failed for ${r.owner}/${r.name} (${p.error?.code ?? (redact(p.stderr.trim().split('\n')[0]) || `exit ${p.status}`)})`, 'check gh auth status and the repo name');
    }
    let page;
    try { page = JSON.parse(p.stdout).data.repository.pullRequests; } catch { fail(`gh api graphql gave no pull requests for ${r.owner}/${r.name}`, 'check gh auth status and the repo name'); }
    nodes.push(...page.nodes);
    // Newest update first: a PR merged or closed in the range was updated in it, so an older update ends the read.
    if (!page.pageInfo.hasNextPage || !page.nodes.length || Date.parse(page.nodes.at(-1).updatedAt) < readFrom) break;
    after = page.pageInfo.endCursor;
  }
  const prs = nodes.filter((n) => Date.parse(n.mergedAt ?? n.closedAt) >= readFrom);
  const merged = prs.filter((n) => n.mergedAt);
  const names = (n, number) => new RegExp(`#${number}(?!\\d)`).test(`${n.title}\n${n.body}`);
  const later = (title, n) => merged.some((m) => title.test(m.title) && m.mergedAt > n.mergedAt && names(m, n.number));
  const rows = prs.map((n) => {
    const commits = n.commits.nodes.map((c) => c.commit), opened = Date.parse(n.createdAt);
    // A commit after the PR opened is rework; it is CI rework when the commit before it had failing checks.
    const rework = commits.map((c, i) => Date.parse(c.authoredDate) > opened && (['FAILURE', 'ERROR'].includes(commits[i - 1]?.statusCheckRollup?.state) ? 'ci' : 'other'));
    return { source, ts: n.mergedAt ?? n.closedAt, ref: `PR #${n.number}`, text: redact(`${n.title}\n\n${n.body ?? ''}`.trim()), data: {
      merged: Boolean(n.mergedAt), bot: n.author?.__typename === 'Bot', hours: n.mergedAt ? (Date.parse(n.mergedAt) - opened) / 3_600_000 : null,
      rework_ci: rework.filter((x) => x === 'ci').length, rework_other: rework.filter((x) => x === 'other').length,
      reverted: Boolean(n.mergedAt) && later(/^revert\b/i, n), escaped: Boolean(n.mergedAt) && later(/^fix\b/i, n),
      partial: n.commits.totalCount > commits.length, labels: n.labels.nodes.map((l) => l.name),
      changes_requested: n.reviews.nodes.filter((v) => v.state === 'CHANGES_REQUESTED').length } };
  });
  return { prs: rows, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

// doctor: readable, the PRs merged or closed in the window, and the partial ones (over 100 commits).
export async function doctor(source, entry, ctx) {
  const { prs } = await read(source, entry, ctx);
  return { level: 'ok', detail: `${prs.length} PRs merged or closed in the window, ${prs.filter((r) => r.data.partial).length} partial (over 100 commits)` };
}

// The numbers over the PRs merged in the window. first_pass is the share of merged PRs by people (not bots) with no
// commit after open that were not reverted or escaped; hours_to_merge is from open to merge, nearest rank.
export const metricNames = ['merged', 'first_pass', 'p50_hours_to_merge', 'p90_hours_to_merge', 'rework_ci', 'rework_other', 'reverted', 'escaped'];
export const metricRows = 'records';
export function metrics(rows, window) {
  const prs = inWindow(rows, window).map((r) => JSON.parse(r.data)).filter((d) => d.merged);
  const people = prs.filter((d) => !d.bot), hours = prs.map((d) => d.hours).sort((a, b) => a - b);
  const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
  const rank = (p) => (hours.length ? round(hours[Math.ceil(p * hours.length) - 1], 2) : null);
  const sum = (f) => prs.reduce((n, d) => n + Number(f(d)), 0);
  const first = people.filter((d) => !d.rework_ci && !d.rework_other && !d.reverted && !d.escaped).length;
  return {
    merged: prs.length, first_pass: people.length ? round((100 * first) / people.length, 1) : null,
    p50_hours_to_merge: rank(0.5), p90_hours_to_merge: rank(0.9),
    rework_ci: sum((d) => d.rework_ci), rework_other: sum((d) => d.rework_other), reverted: sum((d) => d.reverted), escaped: sum((d) => d.escaped),
  };
}
