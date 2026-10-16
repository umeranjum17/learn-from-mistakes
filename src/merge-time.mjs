// When an applied change went live: `apply` commits the fix on its own lfm/<run>-<n>
// branch, but the fix only reaches users when that branch is merged into the default
// branch, days or weeks later. The follow-up windows start at that merge time, not at
// the apply commit's recorded time; the full rule lives in features/followup.md. A
// change recorded by hand keeps its recorded time. Anything git cannot answer falls
// back to the recorded time, so a missing git, a non-git project or an unknown ref
// never fails a run.
import { spawnSync } from 'node:child_process';
import { which } from './runners/index.mjs';

// The apply branch of an apply-recorded change, from the `what` apply writes
// (`fix <run>:<n> on branch <branch>`); undefined for a change recorded by hand.
export function branchOf(change) {
  return /^fix \d+:\d+ on branch (lfm\/[^\s]+)\s*$/.exec(change?.what ?? '')?.[1];
}

// The plain reason an unmerged change carries instead of numbers: one sentence a
// person can read in the report, with no branch, hash or path in it (the report
// leaves text naming those out).
export const NOT_LIVE = 'The fix is not on the default branch yet, so there is no after window.';

const branches = new Map(); // the default branch ref per project dir; its tip is read anew each time
function git(dir, bin, args, input) {
  const r = spawnSync(bin, args, { cwd: dir, input, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// The repo's default branch, from origin's HEAD first, then the usual local names;
// undefined when none resolves, and then the caller keeps the recorded time.
function defaultBranch(dir, bin) {
  if (!branches.has(dir)) {
    const head = git(dir, bin, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    const name = head?.startsWith('refs/remotes/origin/') ? head.slice('refs/remotes/origin/'.length) : undefined;
    const tried = [...(name ? [name, `origin/${name}`] : []), 'main', 'origin/main', 'master', 'origin/master'];
    branches.set(dir, tried.find((b) => git(dir, bin, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])));
  }
  return branches.get(dir);
}

// The patch-id of a commit's change; both sides are computed with the same git,
// so versions never matter. Undefined for an empty or unreadable diff.
function patchId(dir, bin, commit) {
  const diff = git(dir, bin, ['show', commit, '--format=']);
  if (!diff) return undefined;
  const r = spawnSync(bin, ['patch-id'], { cwd: dir, input: diff, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\s+/)[0] : undefined;
}

// A squash or rebase merge copies the fix instead of merging it, so the apply commit
// never becomes an ancestor. Each apply branch holds one commit, so a default-branch
// commit with the same patch-id is the fix going live: measure from the earliest such
// commit. Only commits since the fix are candidates, oldest first and capped, so an
// old branch never scans the whole history.
function squashedAt(dir, bin, ref, tip) {
  const want = patchId(dir, bin, ref), since = git(dir, bin, ['show', '-s', '--format=%cI', ref]);
  if (!want || !since) return undefined;
  const range = [`--since=${since}`, `${ref}...${tip}`], list = (extra) => (git(dir, bin, ['log', '--format=%H', '--no-merges', '--reverse', '--right-only', ...extra, ...range]) ?? '').split('\n').filter(Boolean);
  const kept = new Set(list(['--cherry-pick']));
  // The tip side minus its cherry-picked remainder: the default-branch commits
  // equivalent to some commit on the branch side; only the fix's own patch-id counts.
  for (const c of list([]).filter((h) => !kept.has(h)).slice(0, 100)) {
    if (patchId(dir, bin, c) !== want) continue;
    const at = git(dir, bin, ['show', '-s', '--format=%ct', c]);
    if (/^\d+$/.test(at ?? '')) return Number(at) * 1000;
  }
  return undefined;
}

// The time to measure a change's windows from: `{ at, live }`, with `live: false`
// and the plain reason while the fix's branch has not reached the default branch.
export function liveAt(dir, change) {
  const recorded = Date.parse(change.at);
  try {
    if (!branchOf(change)) return { at: recorded, live: true };
    const bin = which('git');
    if (!bin) return { at: recorded, live: true };
    const def = defaultBranch(dir, bin);
    if (!def) return { at: recorded, live: true };
    const tip = git(dir, bin, ['rev-parse', '--verify', '--quiet', `${def}^{commit}`]);
    const ref = /^[0-9a-f]{7,40}$/.test(change.ref ?? '') && git(dir, bin, ['rev-parse', '--verify', '--quiet', `${change.ref}^{commit}`]);
    if (!tip || !ref) return { at: recorded, live: true };
    if (spawnSync(bin, ['merge-base', '--is-ancestor', ref, tip], { cwd: dir, timeout: 30_000 }).status !== 0) {
      const squash = squashedAt(dir, bin, ref, tip);
      return squash ? { at: Math.max(squash, recorded), live: true } : { at: recorded, live: false, reason: NOT_LIVE };
    }
    // The earliest merge commit on the path that brought the fix in (a fast-forward
    // leaves no merge commit: then the earliest default-branch commit after the fix,
    // or the fix itself when it is the tip, whose time is the only one git knows).
    const first = (out) => out?.split('\n').find((l) => /^\d+$/.test(l));
    const merge = first(git(dir, bin, ['log', '--merges', '--format=%ct', '--reverse', '--ancestry-path', `${ref}..${tip}`]))
      ?? first(git(dir, bin, ['log', '--format=%ct', '--reverse', `${ref}..${tip}`]))
      ?? first(git(dir, bin, ['show', '-s', '--format=%ct', ref]));
    const at = merge ? Number(merge) * 1000 : NaN;
    // The fix cannot be live before it was committed: a backdated merge stays sane.
    return Number.isNaN(at) ? { at: recorded, live: true } : { at: Math.max(at, recorded), live: true };
  } catch {
    return { at: recorded, live: true };
  }
}
