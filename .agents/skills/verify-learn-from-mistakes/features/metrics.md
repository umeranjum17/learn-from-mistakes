# Metrics step and windows (`metrics` step, `causes.*.match`)

## Sub-features
Every run has a `metrics` step between `collect` and `report` (`src/metrics.mjs`).
It saves one row per metric and window in the store's `metrics` table
(`run_id, window, name, value`; `window` is `current` or `previous`; NULL is n/a)
and the run output (`retro`, `status`) adds `window` (`current_start`,
`previous_start`) and `metrics[]{name,current,previous,target,met}`.
Each metric with a `targets:` entry (config or the defaults) saves its `target`
and `met` per window (1 met, 0 missed, NULL when the number is n/a or there is
no target); the output shows the target and `met`, `missed` or `n/a` for the
current window, and empty strings for a metric with no target. The verdict
compares the unrounded number; the output rounds it to 3 decimals. `current` runs from
`now - window` with no end; `previous` is the same length before it. Collect
saves the two starts, so `rerun --resume` counts over the same windows.
Each source type gives its numbers through its `metrics(rows, window)` over the
rows of all its sources (its `metricRows`, `events` or `records`), and names them in `metricNames`: the sessions type
`tool_error_rate`, `corrections_per_session`, `interrupts`, `retries` (its
`events`); the markdown-log type `defects` (its records dated in the window, summed
over every defect log, from the new `records` table, which also holds failed gate
rows). A type with no source in the config gives its names n/a.
`cause_count:<cause>` counts the events and records tagged with that cause in
the window. `collect` tags them through `causes.<c>.match`: a no-mistakes source
by `error_contains` in the row's error, a sessions source by any of `signal`,
`tool` and `text_contains` (checked on the text of signal events only: failed tool
results, retries and corrections; a successful call or a plain message is never
checked, so it matches nothing there; `excerpts: off` tags the same events); each
row takes one cause, the first fitting rule in config order (gate rows too). A target
no source measures, a cause with no `match`, session numbers with no session in
the window and a defect log with no dates are `n/a`, never 0.

## How to get to it (user POV)
`learn-from-mistakes-axi retro --foreground` in any project; add a
`match: { source: sessions, signal: test_fail, text_contains: "<text>" }` under a
cause to count it.

## Driving it with the public CLI
`test/sessions.test.mjs` owns the journey: a synthetic Claude Code store with
events in this window, the last and older, plus a defect log with dated bullets,
gives `tool_error_rate` 0.5/0.75, `corrections_per_session` 0.25/1, `interrupts`
1/0, `retries` 1/0, `defects` 2/1; two sessions rules tag exactly 1 failed test
run and 5 failed Reads (`cause_count` 1/0 and 0/3), the gate rule tags 4 gate
records (0/0, all from March), causes with no rule and unmeasured targets are
`n/a` (NULL in the table); targets give `missed` for `defects` 2 `<= 1`,
`tool_error_rate` and `interrupts` 1 `> 1`, `met` for `corrections_per_session`,
`cause_count` 1 `<= 1` and 0 `= 0`, `n/a` for an n/a number, and the store keeps
both windows' `target`/`met`; the `excerpts: off` run tags the same events.
The same file's `a rule tags signal events only` journey adds a `tool: Bash` rule
that tags the failed Bash result and not the successful one, and a retried quoted
grep matched by `text_contains` on its plain input; `a gate row takes one cause`
checks that an overlapping pair gives the first rule in both metrics and report.
`test/cli.test.mjs` asserts 3 steps per run, that `rerun --resume` keeps the
completed `metrics` step and its numbers, and rejects bad `match` rules and a
second sessions source (exit 2).
The helper's `retro-sessions` drive adds a sessions rule and targets over its three
synthetic sessions (Claude Code, Codex, OpenCode), and checks `tool_error_rate` is 1
and the `test-fails` `cause_count` is 3 in `current`, with `missed`, `met` and `n/a`
(`first_pass`).

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
lfm retro --foreground   # 3 completed steps; metrics with n/a where nothing measures
sqlite3 -readonly .lfm/lfm.sqlite "select window,name,ifnull(value,'n/a'),target,met from metrics"
```

On `$SELF`, counts only: an untracked `.learn-from-mistakes.yaml` with only a
sessions source, `excerpts: off` and a sessions `match` rule, then
`lfm retro --foreground` and the same `select` (numbers only, never session text).
Remove the config and `.lfm/` after.

## Gotchas
The current window has no end, so an event a clock puts slightly after the read
still counts. A defect bullet dated `YYYY-MM-DD` counts from midnight UTC. Two
sources of one type are read together: two defect logs sum into one `defects`. A
second sessions source is rejected (exit 2): each reads every agent's stores, so
its events would count twice.
A metric whose source type is not configured is n/a. `gate_failures`
and the github metrics come in later slices. A target compares the unrounded
number, so `"<= 0.05"` misses 25 failed results of 496 (0.0504) and shows as 0.05.
