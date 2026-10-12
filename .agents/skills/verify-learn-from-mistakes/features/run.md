# Saved runs (`retro --foreground`, `status`, `runs`)

## Sub-features
`learn-from-mistakes-axi retro --foreground` saves a run in the
run store `<state dir>/lfm.sqlite` (node:sqlite, WAL, a migrations list counted
by `PRAGMA user_version`): one `runs` row (status, times, error) and one `steps` row each for `collect`
(ingest) and `report` (the counts with the labels already in the state dir; with
none, coverage shows every record unlabelled). A failed step fails the run
(exit 1, the error saved on the step and the run). `status [--run <id>]` prints
a run and its steps, `runs` lists the last 10 runs newest first. `retro`
without `--foreground` exits 2 (the detached worker is a later slice). The
store commands silence only node:sqlite's `ExperimentalWarning` (Node 22).

## How to get to it (user POV)
In a project with `.learn-from-mistakes.yaml`: `learn-from-mistakes-axi retro --foreground`,
then `learn-from-mistakes-axi status` and `learn-from-mistakes-axi runs`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journey
`retro --foreground saves a run and its steps in .lfm/; status and runs show it`
(status before a run exits 3 and creates no `.lfm`; 2 completed
step rows read back from the store; collect saw 13 log and 5 gate items; report
coverage 0 of 13 labelled; `status --json` equals the retro output; `runs` lists
it; `git status` has no `.lfm`; a project with an empty log fails at `report`
with exit 1 and the saved error), and the rejected-input rows for `retro`
without `--foreground` and a bad `--run`. The helper
drives `retro`, `status` and `runs` on the staged examples to capture evidence.

Real-product proof (outside the repo; `$SCR` is a scratch dir, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
git clone --depth 200 https://github.com/sindresorhus/ky $SCR/ky
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} . \
  && lfm retro --foreground && lfm runs && lfm status && git status --short
```

`git status --short` must show only the 3 copied files (`.lfm` is ignored).
Repeat in a scratch copy of `$SELF/examples`. On Node 22.13+ the store commands'
stderr must hold no `ExperimentalWarning`.

## Gotchas
Foreground only: a run killed mid-step stays `running` until the reconcile of
a later slice. Steps after a failed one stay `pending`. `collect` reads every
record. Windows come in a later slice, with the code that applies them.
