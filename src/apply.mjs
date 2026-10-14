// Applies a retro's kept fixes, each on its own branch: the worker (agent:, never the judge) answers each fix with the new text
// of the repo files its target names, and the tool commits that from HEAD with git's plumbing on lfm/<run>-<n> and records it
// as `change applied --proposal <run>:<n>` does. The user's branch, index and work tree are never touched; nothing is pushed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { EmptyError, InputError, readLedger, recordableCauses, recordChange, UsageError, withContext } from '../bin/learn-from-mistakes-axi.mjs';
import { PROJECT_FILE } from './config.mjs';
import { redact } from './redact.mjs';
import { which } from './runners/index.mjs';
import { agentStep } from './steps/agent-step.mjs';
import { openStore } from './store.mjs';

const PROMPT = readFileSync(new URL('./prompts/apply.md', import.meta.url), 'utf8');
const KEPT = 'SELECT p.*, s.answer FROM proposals p LEFT JOIN signoff s ON s.proposal_id = p.id WHERE p.run_id = ? AND p.n IS NOT NULL ORDER BY p.n';

function git(dir, args, { input, env } = {}) {
  const bin = which('git');
  if (!bin) throw new InputError('git is not on PATH', 'install git   # apply puts each fix on a new branch');
  const r = spawnSync(bin, args, { cwd: dir, input, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new InputError(`git ${args[0]}: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0]}`, 'git status   # apply needs a git repo with a commit');
  return r.stdout.trim();
}

// The tracked regular files the target names, by their path from the repo root, with their git mode.
function targetFiles(top, target) {
  const tracked = new Map(git(top, ['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((l) => [l.slice(l.indexOf('\t') + 1), l.slice(0, 6)]));
  const words = target.split(/[\s,;`'"()]+/).map((w) => posix.normalize(w.replace(/[.:]+$/, '')).replace(/^\.\//, ''));
  return [...new Set(words)].filter((w) => ['100644', '100755'].includes(tracked.get(w))).map((path) => ({ path, mode: tracked.get(path) }));
}

// One kept fix: its branch, commit and ledger change. A fix already on its branch is only recorded, once.
async function applyOne(cfg, db, run, fix, log, opts = {}) {
  const at = `${run}:${fix.n}`, branch = `lfm/${run}-${fix.n}`;
  if (fix.answer === 'skip') throw new UsageError(`fix ${at} was answered Skip, and a Skip is never applied`, withContext(`learn-from-mistakes-axi status --run ${run}`, 'its other kept fixes', opts));
  if (!recordableCauses(cfg).includes(fix.cause)) throw new InputError(`fix ${at} names cause ${fix.cause}, which is not a configured cause`, `add ${fix.cause} under causes in ${PROJECT_FILE}, then apply again`);
  const top = git(cfg.dir, ['rev-parse', '--show-toplevel']);
  if (git(top, ['status', '--porcelain', '--untracked-files=no'])) throw new InputError(`${top} has uncommitted changes; apply never touches them`, 'git status   # commit or stash them, then apply again');
  const head = git(top, ['rev-parse', '--verify', 'HEAD']); let commit = spawnSync(which('git'), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: top, encoding: 'utf8' }).stdout.trim();
  if (!commit) {
    const files = targetFiles(top, fix.target); const gone = files.filter((f) => !existsSync(join(top, f.path)));
    if (gone.length) throw new InputError(`fix ${at} names a tracked file that is not checked out in the worktree: ${gone.map((f) => f.path).join(', ')}`, `git update-index --no-skip-worktree <path> && git checkout HEAD -- <path>   # apply reads the file from the worktree`);
    if (!files.length) throw new InputError(`fix ${at} names no tracked file in its target, so the worker has nothing to edit`, withContext(`learn-from-mistakes-axi change applied --proposal ${at} --ref <sha>   # after you make the change by hand`, 'nothing was applied', opts));
    const text = new Map(files.map((f) => [f.path, readFileSync(join(top, f.path), 'utf8')])), fill = { cause: fix.cause, kind: fix.kind ?? 'doc', target: redact(fix.target), change: redact(fix.change), metric: fix.metric, tripwire: fix.tripwire,
      files: files.map((f) => `--- ${f.path}\n${text.get(f.path)}\n--- end of ${f.path}`).join('\n') };
    const check = (v) => {
      if (!Array.isArray(v.files) || !v.files.length) return ['files must be a list of the files you changed'];
      const p = v.files.flatMap((f, i) => (!text.has(f?.path) ? [`files[${i}].path must be one of the listed files`] : typeof f.content !== 'string' ? [`files[${i}].content must be the whole new text`] : []));
      if (new Set(v.files.map((f) => f?.path)).size !== v.files.length) p.push('files names one file twice');
      return !p.length && v.files.every((f) => f.content === text.get(f.path)) ? ['the answer changes no file'] : p;
    };
    const dir = join(cfg.state, 'runs', String(run)); mkdirSync(dir, { recursive: true });
    const answer = await agentStep(cfg, db, run, dir, { step: `apply-${fix.n}`, role: 'worker', prompt: PROMPT.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k]), check, log, bundle: false });
    // A private index: the new tree is HEAD's with the worker's files, and the user's own index is never read or written.
    const env = { GIT_INDEX_FILE: join(dir, `apply-${fix.n}.index`) };
    try {
      git(top, ['read-tree', head], { env });
      for (const f of answer.files) {
        const blob = git(top, ['hash-object', '-w', '--stdin'], { input: f.content });
        git(top, ['update-index', '--cacheinfo', `${files.find((x) => x.path === f.path).mode},${blob},${f.path}`], { env });
      }
      const tree = git(top, ['write-tree'], { env });
      commit = git(top, ['commit-tree', tree, '-p', head, '-m', `learn-from-mistakes: fix ${at} for ${fix.cause}\n\n${redact(fix.change)}`]);
      git(top, ['branch', branch, commit]);
    } finally { rmSync(env.GIT_INDEX_FILE, { force: true }); }
  }
  const change = readLedger(join(cfg.state, 'changes.jsonl')).entries.find((e) => e.ref === commit)?.id
    ?? (await recordChange(cfg, { proposal: at, ref: commit, kind: fix.kind ?? undefined, what: `fix ${at} on branch ${branch}` })).id;
  return { fix: fix.n, branch, commit, change };
}
const line = (run, a) => `applied: fix ${run}:${a.fix} on branch ${a.branch}, commit ${a.commit.slice(0, 12)}, ledger ${a.change}`;

// The run's apply step: with auto_fix: n, the top n kept fixes, without an answer; 0 (the default) proposes only.
export async function autoApply(cfg, db, id, log) {
  if (!cfg.auto_fix) { log('auto_fix: 0, so nothing is applied: answer Apply on a fix, then learn-from-mistakes-axi apply'); return { applied: [] }; }
  const applied = [];
  for (const fix of db.prepare(KEPT).all(id).filter((f) => f.answer !== 'skip').slice(0, cfg.auto_fix)) {
    try { applied.push(await applyOne(cfg, db, id, fix, log)); log(line(id, applied.at(-1))); } catch (e) {
      if (!(e instanceof UsageError)) throw e;
      log(`refused: fix ${id}:${fix.n} was not applied: ${e.message}`);
    }
  }
  return { applied };
}

// `apply`: each kept fix of the run (default: the last run with kept fixes) the user answered Apply, or the one fix
// --fix names (the plain-text fallback). Prints one line per fix as it is applied; the worker's call lines go to stderr.
export async function apply(cfg, opts) {
  const db = await openStore(cfg.state, false);
  const run = db && (opts.run ? Number(opts.run) : db.prepare('SELECT max(run_id) AS id FROM proposals WHERE n IS NOT NULL').get().id);
  if (run == null) throw new EmptyError('no retro run has kept fixes', withContext('learn-from-mistakes-axi retro --wait 15m', 'a run that proposes fixes', opts));
  try {
    const fixes = db.prepare(KEPT).all(run), chosen = opts.fix ? fixes.filter((f) => f.n === Number(opts.fix)) : fixes.filter((f) => f.answer === 'apply');
    if (opts.fix && !chosen.length) throw new UsageError(`run ${run} has no kept fix ${opts.fix}`, withContext(`learn-from-mistakes-axi status --run ${run}`, 'its kept fixes', opts));
    if (!chosen.length) throw new EmptyError(`run ${run} has no fix answered Apply`, withContext(`learn-from-mistakes-axi apply --run ${run} --fix <n>`, 'apply a kept fix you accept; signoff answers reads the board first', opts));
    const done = [];
    for (const fix of chosen) {
      done.push(await applyOne(cfg, db, run, fix, console.error, opts));
      console.log(line(run, done.at(-1)));
    }
    console.error(`next: git diff HEAD...${done[0].branch}   # review it, then push the branch and open a PR the way you deliver`);
  } finally { db.close(); }
}
