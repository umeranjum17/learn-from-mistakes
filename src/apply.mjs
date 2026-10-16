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
// A reply the worker's output limit cut off. It is seen one of two ways: a stop reason the runner reported (a length or
// max-tokens cut), or, when the runner reported no stop reason, a shape change a whole-file reply never makes — a normal
// small edit only trims a little, so a reply that ends mid-line (beyond a trailing newline) or drops more than half the
// file (with no removal the change names) is refused, never committed, and never recorded. A runner-reported normal stop
// is the runner's own word the reply is whole, so the shape checks are skipped; a length stop always refuses.
const LENGTH_STOP = /\b(length|max[_-]?output[_-]?tokens?|max[_-]?tokens?|token[_-]?limit|truncated|incomplete)\b/i;
const NAMES_REMOVAL = /\b(remov|delet|drop|dedup|prune|shrink|shrank|shorten|trim|consolidat)\w*/i;

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
  const paths = [...new Set(target.split(/[\s,;`'"()]+/).map((w) => posix.normalize(w.replace(/:\d+$/, '').replace(/[.:]+$/, '')).replace(/^\.\//, '')).filter((w) => ['100644', '100755'].includes(tracked.get(w))))];
  return paths.map((path) => ({ path, mode: tracked.get(path) }));
}

// One kept fix: its branch, commit and ledger change. A fix already on its branch is only recorded, once.
async function applyOne(cfg, db, run, fix, log, opts = {}) {
  const at = `${run}:${fix.n}`, branch = `lfm/${run}-${fix.n}`,
  // The branch's identity for this fix: run, fix, cause, target and change. The target is part of it, so a reused
  // run id with the same cause and change text for another file never matches this branch and is refused, not applied.
  message = `learn-from-mistakes: fix ${at} for ${fix.cause}\n\ntarget: ${redact(fix.target)}\n\n${redact(fix.change)}`;
  if (fix.answer === 'skip') throw new UsageError(`fix ${at} was answered Skip, and a Skip is never applied`, withContext(`learn-from-mistakes-axi status --run ${run}`, 'its other kept fixes', opts));
  if (!recordableCauses(cfg).includes(fix.cause)) throw new InputError(`fix ${at} names cause ${fix.cause}, which is not a configured cause`, `add ${fix.cause} under causes in ${PROJECT_FILE}, then apply again`);
  const top = git(cfg.dir, ['rev-parse', '--show-toplevel']);
  if (git(top, ['status', '--porcelain', '--untracked-files=no'])) throw new InputError(`${top} has uncommitted changes; apply never touches them`, 'git status   # commit or stash them, then apply again');
  const head = git(top, ['rev-parse', '--verify', 'HEAD']); let commit = spawnSync(which('git'), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: top, encoding: 'utf8' }).stdout.trim();
  if (commit && git(top, ['show', '-s', '--format=%B', commit]) !== message) throw new InputError(`branch ${branch} holds ${commit.slice(0, 7)} instead of the fix ${at} apply commit`, `git branch -D ${branch}   # delete or rename the stale branch, then apply again`);
  if (!commit) {
    const files = targetFiles(top, fix.target); const gone = files.filter((f) => !existsSync(join(top, f.path)));
    if (gone.length) throw new InputError(`fix ${at} names a tracked file that is not checked out in the worktree: ${gone.map((f) => f.path).join(', ')}`, `git update-index --no-skip-worktree <path> && git checkout HEAD -- <path>   # apply reads the file from the worktree`);
    if (!files.length) throw new InputError(`fix ${at} names no tracked file in its target ${JSON.stringify(fix.target)}, so the worker has nothing to edit`, withContext(`learn-from-mistakes-axi change applied --proposal ${at} --ref <sha>   # after you make the change by hand`, 'nothing was applied', opts));
    for (const f of files) if (git(top, ['hash-object', '--path', f.path, '--', f.path]) !== git(top, ['rev-parse', `HEAD:${f.path}`])) throw new InputError(`${top} has uncommitted changes; apply never touches them`, 'git status   # commit or stash them, then apply again');
    // The worker edits UTF-8 text: a target that is not valid UTF-8 would decode to replacement
    // characters and commit corrupted text, so it is refused before the worker is asked.
    const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }), text = new Map();
    for (const f of files) {
      try { text.set(f.path, fatal.decode(readFileSync(join(top, f.path)))); }
      catch { throw new InputError(`fix ${at} names ${f.path}, which is not valid UTF-8, so the worker cannot edit it`, `convert ${f.path} to UTF-8, then apply again`); }
    }
    const fill = { cause: fix.cause, kind: fix.kind ?? 'doc', target: redact(fix.target), change: redact(fix.change), metric: fix.metric, tripwire: fix.tripwire,
      files: files.map((f) => `--- ${f.path}\n${text.get(f.path)}\n--- end of ${f.path}`).join('\n') };
    // The reply must be the whole new file. A reply the worker's output limit cut off — a length/max-tokens stop the
    // runner reported, or a shape change a whole-file reply never makes — is refused here: it names the file and reason,
    // commits nothing and records nothing. It is thrown, not sent back, because a length stop repeats on a retry.
    const cutoff = (v, stop) => {
      if (stop && LENGTH_STOP.test(stop)) return { file: v.files.map((f) => f.path).join(' and '), reason: `the reply stopped at ${JSON.stringify(stop)}` };
      if (stop) return;
      for (const f of v.files) {
        const before = text.get(f.path), after = f.content;
        if (before.endsWith('\n') && !after.endsWith('\n') && before.replace(/\n+$/, '') !== after.replace(/\n+$/, '')) return { file: f.path, reason: 'it ends mid-line where the file ended with a newline' };
        if (after.length * 2 < before.length && !NAMES_REMOVAL.test(fix.change)) return { file: f.path, reason: 'the new text drops more than half the file, and the fix names no removal', shrink: true };
      }
    };
    const check = (v, attempt, stop) => {
      if (!Array.isArray(v.files) || !v.files.length) return ['files must be a list of the files you changed'];
      const p = v.files.flatMap((f, i) => (!text.has(f?.path) ? [`files[${i}].path must be one of the listed files`] : typeof f.content !== 'string' ? [`files[${i}].content must be the whole new text`] : []));
      if (new Set(v.files.map((f) => f?.path)).size !== v.files.length) p.push('files names one file twice');
      if (p.length) return p;
      if (v.files.every((f) => f.content === text.get(f.path))) return ['the answer changes no file'];
      const cut = cutoff(v, stop);
      if (cut) throw new InputError(`fix ${at}: the worker's reply for ${cut.file} was cut off (${cut.reason}); apply refuses to commit an incomplete file`, cut.shrink
        ? `name the removal in the change text, or make the edit by hand and record it with change applied --proposal ${at} --ref <sha>, then apply again`
        : `learn-from-mistakes-axi apply --fix ${fix.n}   # the worker hit its output limit; shorten the change or raise the model's output limit, then apply again`);
      return [];
    };
    const dir = join(cfg.state, 'runs', String(run)); mkdirSync(dir, { recursive: true });
    const answer = await agentStep(cfg, db, run, dir, { step: `apply-${fix.n}`, role: 'worker', prompt: PROMPT.replace(/\{\{(\w+)\}\}/g, (_, k) => fill[k]), check, log, bundle: false });
    // A private index: the new tree is HEAD's with the worker's files, and the user's own index is never read or written.
    const env = { GIT_INDEX_FILE: join(dir, `apply-${fix.n}.index`) };
    try {
      git(top, ['read-tree', head], { env });
      for (const f of answer.files) {
        const blob = git(top, ['hash-object', '-w', '--stdin', '--path', f.path], { input: f.content });
        git(top, ['update-index', '--cacheinfo', `${files.find((x) => x.path === f.path).mode},${blob},${f.path}`], { env });
      }
      const tree = git(top, ['write-tree'], { env });
      commit = git(top, ['commit-tree', tree, '-p', head, '-m', message]);
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
  if (db && opts.run && !db.prepare('SELECT 1 FROM runs WHERE id = ?').get(run)) throw new UsageError(`no run ${run}`, withContext('learn-from-mistakes-axi runs', 'the saved run ids', opts));
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
