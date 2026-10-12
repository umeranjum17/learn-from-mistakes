# Saved runs (`retro`, `status`, `runs`, `attach`, `logs`, `abort`, `rerun`)

## Sub-features
`learn-from-mistakes-axi retro` saves a run in the
run store `<state dir>/lfm.sqlite` (node:sqlite, WAL, a migrations list counted
by `PRAGMA user_version`): one `runs` row (status, owner pid, times, error) and one `steps` row each for `collect`
(ingest) and `report` (the counts with the labels already in the state dir; with
none, coverage shows every record unlabelled). A detached worker (the hidden
`_work <id>` command, stdio in `.lfm/runs/<id>/worker.log`) runs the steps, so
the run goes on when the terminal or the calling agent ends. `retro` returns at
once with the run `running`; `--wait <time>` (30s, 8m, 1h; a bare `--wait` is 8m) polls until the run
ends or the time is over; `--foreground` runs the steps in the same process. The run output adds `sources`: each
source's id, type and item count (and a sessions source's counts and numbers, see [sessions.md](sessions.md)).
A failed step fails the run (exit 1, the error saved on the step and the run).
`status [--run <id>]` prints a run and its steps, `runs` lists the last 10 runs
newest first. `retro`, `status`, `runs` and `rerun` first reconcile: a running
run whose owner pid is dead (or now another process, by start time) becomes
`interrupted`, with its running step. A unique index and a `BEGIN IMMEDIATE`
check allow one running run; a second `retro` exits 2 and names it. The worker
takes the run from the process that started it and refuses a run that ended or
that another worker owns. `rerun --resume [--run <id>]` runs an
interrupted, cancelled or failed run from its first step that is not completed;
completed steps keep their times and output. SIGTERM or SIGINT to the worker
ends the run as `cancelled`. Each step writes its lines (collect: one per source;
report: the `repeated:` summary; a failed step: `error: <why>`) to
`.lfm/runs/<id>/<step>.log`, new for each attempt. `attach [--run <id>]` polls
every second and prints `<step>: running`, `<step>: <log line>` and
`<step>: <end state>` as they come, then the run as `status` prints it; it exits
0 for a completed run, 1 for any other end, 3 before the first run (`--json`
moves the step lines to stderr). `logs --step <name> [--run <id>]` prints
`step`, `run`, `status`, `lines: <n> total` and `log[n]{line}`; an unknown step
exits 2 naming the run's steps. `abort [--run <id>]` (default: the running run)
sends SIGTERM to the worker (only when its pid still has the saved start time),
and SIGKILL after 3 s if it is still alive, then marks the run `cancelled`; it
exits 2 when no run is running. A plain `rerun [--run <id>]` starts a new run with
the same settings (today all in the config); `retro` while a run is running
exits 2 and names it, with `next: ... attach --run <id>`.
The store commands silence only node:sqlite's `ExperimentalWarning` (Node 22),
and the worker starts with `--disable-warning=ExperimentalWarning`.

## How to get to it (user POV)
In a project with `.learn-from-mistakes.yaml`: `learn-from-mistakes-axi retro --wait 8m`
(or `retro`, then `status`), `learn-from-mistakes-axi runs`, and after a crash
`learn-from-mistakes-axi rerun --resume`. Follow a run with `attach`, read one
step with `logs --step collect`, stop it with `abort`, start it again with `rerun`.

## Driving it with the public CLI
`test/cli.test.mjs` owns three journeys.
`retro --foreground saves a run and its steps in .lfm/; status and runs show it`:
status before a run exits 3 and creates no `.lfm`; 2 completed
step rows read back from the store; collect saw 13 log and 5 gate items; report
coverage 0 of 13 labelled; `status --json` equals the retro output; `runs` lists
it; `git status` has no `.lfm`; a project with an empty log fails at `report`
with exit 1 and the saved error.
`retro runs in a detached worker; a killed worker is interrupted and rerun --resume finishes it`:
`retro --wait 1m` completes; with `LFM_TEST_SLOW_STEP=report` (a test-only env
flag: that step sleeps 60 s) a plain `retro` returns `running` while the worker
goes on; a second `retro` exits 2 naming it; `SIGKILL` to the worker pid gives
`interrupted` with `report` interrupted and `collect` completed; a new
`retro --wait` (bare, 8m) completes; `rerun --resume --run <id> --wait 1m` completes
with `collect` byte-identical (not run again); a second resume exits 2.
`attach follows a run to its end; logs prints one step; abort cancels a run and rerun starts it again`:
`attach` before a run exits 3; with `LFM_TEST_SLOW_STEP=report:3000` (`<step>:<ms>`)
`attach` prints the collect source lines, `collect: completed`, `report: running`,
the `repeated:` line and `report: completed` in that order, then the completed run,
and exits 0; `logs --step collect --json` gives `2 total` lines; `logs --step analyse`
exits 2; with a 60 s report step, a second `retro` exits 2 naming the run, `abort`
gives `cancelled` (`report: cancelled by SIGTERM`, the worker pid gone), a second
`abort` exits 2; `rerun --run <id> --wait 1m` completes a new run.
The rejected-input rows cover a bad `--wait`, `--wait` with `--foreground`,
`logs` without `--step`, a bad `--step`, `attach --wait` and a bad `--run`. The helper drives
`retro --foreground`, `retro --wait 1m`, `status`, `runs`, `attach`, `logs --step collect`,
`abort` on a slow run and `rerun --wait 1m` on the staged examples to capture evidence.

Real-product proof (outside the repo; `$SCR` is a scratch dir, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
git clone --depth 200 https://github.com/sindresorhus/ky $SCR/ky
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} . \
  && lfm retro --wait 1m && lfm runs && git status --short
# the run outlives its shell: start it in a shell that exits at once, then read it from a new shell
bash -c 'cd "$2" && exec node "$1/bin/learn-from-mistakes-axi.mjs" retro' _ "$SELF" "$SCR/ky"
sleep 5; bash -c 'cd "$2" && exec node "$1/bin/learn-from-mistakes-axi.mjs" status' _ "$SELF" "$SCR/ky"   # completed
# a crash mid-step, then resume
LFM_TEST_SLOW_STEP=report lfm retro; sleep 2; kill -9 "$(lfm status --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).run.pid')"
lfm status; lfm retro --wait 1m; lfm rerun --resume --run <interrupted id> --wait 1m
# follow, read one step, stop, start again
lfm retro && lfm attach && lfm logs --step collect && lfm rerun --wait 1m && lfm runs
LFM_TEST_SLOW_STEP=report lfm retro; lfm abort; lfm runs   # the last run is cancelled
```

`git status --short` must show only the 3 copied files (`.lfm` is ignored).
Repeat in a scratch copy of `$SELF/examples`. On Node 22.13+ the store commands'
stderr must hold no `ExperimentalWarning`.

## Gotchas
Reconcile needs `/proc` (Linux) or `ps -o lstart=` (macOS) to read a process
start time. Steps after a failed one stay `pending`. `collect` reads every
record; only the sessions source applies the read range (`window`).
`abort` has no agent child to stop yet: agent steps (and their stored child
process groups) come in a later slice. A synchronous step reads SIGTERM only when
it ends, so `abort` falls back to SIGKILL after 3 s.
