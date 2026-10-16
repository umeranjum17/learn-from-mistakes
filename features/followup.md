# Follow-up: when a change went live

An applied change is measured from when its fix went live, not from when it was recorded.

`apply` commits each kept fix on its own `lfm/<run>-<n>` branch, but the fix only reaches users when that branch is merged into the default branch, and days or weeks can pass in between.
Measuring from the apply commit would count records from before the fix was live in the after window and give the wrong verdict.
So for a change whose ledger entry names its apply branch (the `what` that `apply` writes, `fix <run>:<n> on branch <branch>`), the follow-up step resolves the time that fix commit became reachable from the default branch and starts the after window there; the before window of one window length ends at the same time.

While the branch is not merged, the change is not live yet: it gets n/a numbers and `no-data`, never a verdict, with the plain reason `The fix is not on the default branch yet, so there is no after window.`
The propose step keeps that reason as written and never asks the worker to explain the change.

A change recorded by hand with `change applied` keeps its recorded time.

The default branch is read from the repo itself: `refs/remotes/origin/HEAD` first, then `main`, `master`, and their `origin/` forms.
The live time is the committer time of the earliest merge commit on the path that brought the fix in; a fast-forward leaves no merge commit, so it falls back to the earliest default-branch commit after the fix, or the fix commit itself when it is the tip.
Anything git cannot answer (no git, a non-git project, an unknown ref, a `sha256:` ref, no resolvable default branch) keeps the recorded time, and the run never fails over it.
A branch merged by squash or rebase copies the fix instead of merging it, so the apply commit never becomes an ancestor.
Each apply branch holds one commit, so a default-branch commit with the same patch-id is the fix going live: the window starts at the earliest such commit's committer time.
Only then, when no equivalent commit exists on the default branch, the change stays `no-data` until it is recorded by hand.
