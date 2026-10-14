# Apply a kept fix (`apply` command, `apply` step, `auto_fix`)

## Sub-features
`learn-from-mistakes-axi apply [--run <id>] [--fix <n>]` (`src/apply.mjs`) takes each kept fix answered Apply
(`signoff answers`), or the one `--fix` names. The worker (never the judge) gets one tool-off call per fix with no
bundle: the fix and the tracked files its target names; it answers each changed file's whole text. The tool commits
that with a private index on a new branch `lfm/<run>-<n>` from HEAD, then records `change applied --proposal` with the
commit as `ref`. The user's branch, index and work tree stay as they were; nothing is pushed. A run's last step, `apply`,
does the same for the top `auto_fix` kept fixes with no answer (0, the default, applies none). A Skip exits 2, no Apply
answer exits 3, a dirty tree exits 1, a target with no tracked file exits 1 with the `change applied` fallback.

## Drive
`retro --foreground`, `signoff answers` (fake peer), then `apply`; `git log lfm/<run>-1`, `git status`, `changes`.
Expected: `applied: fix <run>:1 on branch lfm/<run>-1, commit <sha>, ledger chg-1`, the branch's parent is HEAD,
a clean status, and a rerun adds no ledger line. Journey: `apply: the worker makes an accepted fix` in `test/cli.test.mjs`.
