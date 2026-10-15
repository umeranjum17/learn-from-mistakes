# Follow-up step and verdicts (`followup` step, `followups` table)

## Sub-features
Every run has a `followup` step between `metrics` and `report`
(`src/followup.mjs`). For each entry in the change ledger it computes the
entry's `metric` (default `cause_count:<cause>`) with the same code as the
metrics step: `before` over one `window` up to the change's `at`, `after`
from `at` with no end. `collect` reads from `read_from`, the earlier of the
last window's start and the earliest change's `at` minus one window, so an old
change still has its before number. The step saves one row per change in
`followups` (`run_id, change_id, metric, before, after, tripwire, verdict`;
unrounded numbers, NULL for n/a and for no tripwire) and the run output
(`retro`, `status`) adds `followups[]{change,metric,before,after,tripwire,verdict}`
(numbers rounded to 3 decimals, `n/a`, `''` for no tripwire). Its log has one
line per change, rounded the same way. A ledger line whose `at` is not a time
is a ledger problem, so it never gets a row. The verdict is code, the first rule that fits:

1. `no-data`: fewer than `followup.min_sessions` sessions (with an event at or
   after `at`) or fewer than `followup.min_days` days from `at` to the run, or
   the metric is n/a before or after, or a records-based metric (a `cause_count`
   whose match rule names a no-mistakes source, `defects` from a defect log or a firstmate home, or a
   `gate_failures:<step>` metric) has no record on or
   before the start of the before window, so its `before` is n/a (the source does
   not cover that window). A change added after `collect` read the ledger can have
   an `at` older than what `collect` read (`read_from`): its `before` is n/a when
   `read_from` is after the start of its before window, and its `after` is n/a
   when `read_from` is after `at`.
2. `keep`: the tripwire is met (a met rule change is kept, never deleted).
3. `delete`: a `kind: rule` change whose metric moved less than 10% of `before`
   (or stayed 0) in this run and in the last run; a missed tripwire or none does
   not stop it.
4. `no-data`: the change has no tripwire.
5. `rollback`: the tripwire missed and the number did not improve (lower for
   `<`/`<=`, higher for `>`/`>=`, nearer the number for `=`), or the tripwire
   also missed in the last run.
6. `fix`: improved, but the tripwire missed.

"The last run" is the change's row in the latest earlier run that measured
it whose read time is at least `followup.min_days` before this run's (a run
that failed or was cancelled before `followup` has none). A rerun over the same
data is not a second run, so it never gives `delete` or the missed-twice
`rollback`; the closer run is skipped and the one before it is used. When that
run fails rule 1 (its numbers, and the sessions and days of its after range
counted again with this run's events), there is no last run. A change with no
tripwire is `no-data` each run but can still be deleted.

## How to get to it (user POV)
`learn-from-mistakes-axi change applied --cause <c> --ref <sha> --tripwire "<= 0" [--kind rule]`,
then `learn-from-mistakes-axi retro --foreground` (or `status`) lists each change's verdict.

## Driving it with the public CLI
`test/followup.test.mjs` owns the journey: synthetic Claude Code sessions 20,
5, 2 and 0.5 days back, a defect log whose first record is 4 days back, and
eleven changes give, on the first retro, `keep`
(4 -> 0), `rollback` (4 -> 5), `rollback` for a flat rule change (2 -> 2),
`fix` (4 -> 2 against `<= 1`), `no-data` for one session after the change, for a
cause with no match rule (n/a), for no tripwire and for a flat rule change with no tripwire, and `rollback` for a change
15 days back whose before number comes from a session older than both windows
(read only through `read_from`). A met rule change (4 -> 4 against `<= 4`) is `keep`,
and a change on `defects` 6 days back is `no-data` with n/a before, since the log
has no record by the start of its window. The second retro gives `delete` for both flat
rule changes and `rollback` for the fixed one, and still `keep` for the met one;
`status --run <first>` still shows the first verdicts; the store keeps NULL for n/a
and no tripwire.
`test/cli.test.mjs` asserts 10 steps per run and that `rerun --resume` keeps the
completed `followup` step. The helper's `change-followup` and `retro-followup`
drives add a change between an old failed test run and the three synthetic
sessions and check `rollback` (1 before, 3 after).

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
lfm change applied --cause agent-exit-wait --ref $(git rev-parse HEAD) --metric cause_count:agent-exit-wait --tripwire "<= 0"
lfm retro --foreground && sqlite3 -readonly .lfm/lfm.sqlite "select * from followups"
```

The same on a scratch copy of `$SELF/examples`, never the real ledger.

## Gotchas
Session counts come only from a `sessions` source, so a project with none
gets `no-data` for every change. The rules are this tool's own: the fleet
sources have no rollback threshold.
