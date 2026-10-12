# Applied-change ledger

## Sub-features
`learn-from-mistakes-axi change applied` validation (cause key, never `other`; git-sha or
`sha256:` ref; readable `--at`; optional `--metric` (a metric name or
`cause_count:<configured cause>`, default `cause_count:<cause>`), `--tripwire`
(`"<op> <number>"`, saved as `<op> <number>`, default none) and `--kind`
(`doc`, `rule` or `code`, default `doc`); optional `--what`/`--why`, trimmed, one line of
1-200 characters); one-append ledger writes with `chg-<n>` ids;
the report's per-cause `changes` counts, `last_at`, top-level
`ledger.entries`, and `--full`-only `change_ids`/`change_refs`; the
`lfm changes` export (`lfm-changes.v1`: `generated_at`, `project`, and per
change `id`, `cause`, `ref`, `at`, `metric`, `tripwire`, `kind`, `what`, `why`)
that other tools join on `project` + `id`. A ledger line written before
`metric`/`tripwire`/`kind` loads with the defaults.

## How to get to it (user POV)
After making a recommended change: `learn-from-mistakes-axi change applied --cause <cause>
--ref <sha> --metric cause_count:<cause> --tripwire "<= 0" --what <text> --why <text>`, then `learn-from-mistakes-axi report` shows it under that
cause and `learn-from-mistakes-axi changes --json` lists it with its what and why.

## Driving it with the public CLI
`test/cli.test.mjs` owns the ledger journey: two changes in separate processes
with the first entry's bytes an exact prefix after the second; every rejected
input (bad cause, `other`, bad ref, bad `--at`, unknown or report-only flag,
missing `--ref`, a bad `--tripwire` such as `< x`, an unknown `--metric` or
`--kind`, corrupt existing ledger) exits without touching ledger bytes, and
names the bad flag or value on one `error:` line (see [surface.md](surface.md));
a fresh `report --json` shows the counts and `--full --json` the ids; TOON
decodes equal to JSON; planted record/label/proposal prose never reaches any
output. The same journey owns the export: `changes --json` before ingest is an
empty `lfm-changes.v1`; changes with and without what/why in separate
processes; rejected what/why (empty, blank, 201 characters, newline, control
character, missing value) append nothing and name the rule, never the text;
the `change applied` echo carries `metric`/`tripwire`/`kind` but never what/why; a corrupt ledger, a
hand-edited entry with bad what/why, tripwire or kind, or an empty metric (the ledger checks
a metric as it checks a cause: a non-empty string, never against the config), or a repeated id exits 1 with `file:line`
and empty stdout; report/change flags are rejected; ids and entries
are unchanged after a later append (a 200-character what is accepted); TOON
decodes equal to JSON; owner what/why markers appear in `changes` but never in
any report output; a hand-written line with no `metric`/`tripwire`/`kind`
exports the defaults and a later `change applied` still appends `chg-<n+1>`.
The rejection table in `every rejected input names what was wrong` checks each
bad `--tripwire`/`--metric`/`--kind` names its allowed form and the change form. The helper drives `changes-empty`, `change-applied` (with `--metric`,
`--tripwire`, `--kind`), `change-bad-tripwire` (exit 2), `changes` and
`changes-json` (asserts the three fields) to capture evidence; with `--package` it
drives `packed-changes` and reruns the suite through the installed bin
(`packed-npm-test`, `LFM_CLI`).

## Gotchas
Single writer is assumed; concurrent writers could repeat an id (a lock file is
the upgrade). New ids are the highest `chg-<n>` + 1; a repeated id is a ledger
problem, so `changes` never exports a duplicate join key. A missing ledger means zero entries; an invalid one exits 1 with
file:line only. What/why are owner-written text meant to leave the privacy
bound only through `changes`; the report never prints them. `generated_at` is
the export time, so compare TOON to JSON without it. The ledger only records
the metric and tripwire; the follow-up step that measures them and gives a
verdict comes in a later slice.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
lfm change applied --cause agent-exit-wait --ref $(git rev-parse HEAD) --metric cause_count:agent-exit-wait --tripwire "<= 0"
lfm change applied --cause agent-exit-wait --ref $(git rev-parse HEAD) --tripwire "< x"   # exit 2, the allowed form
lfm changes --json   # metric, tripwire, kind on the entry
```

The same on a scratch copy of `$SELF/examples`, never the real ledger.
