# Apply a kept fix (`apply`, `apply` step, `auto_fix`)

`apply [--run <id>] [--fix <n>]` (`src/apply.mjs`) and the run's `apply` step (`auto_fix: <n>`, 0 by default) make each kept fix answered Apply, or the top n not answered Skip: one tool-off worker call per fix, one commit on `lfm/<run>-<n>` from HEAD, then `change applied --proposal`. The user's branch, index and work tree stay. Skip exits 2, no Apply answer exits 3, a dirty tree or no tracked target file exits 1; in a run each refusal logs `refused:` and the run stays ok.

Drive: `retro --foreground`, `signoff answers` (fake peer), `apply`, `git log lfm/<run>-1`, `git status`, `changes`. Journey: `apply: the worker makes an accepted fix` in `test/cli.test.mjs`.
