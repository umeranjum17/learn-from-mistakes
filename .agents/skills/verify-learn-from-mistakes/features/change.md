# Applied-change ledger

## Sub-features
`lfm change applied` validation (cause key, never `other`; git-sha or
`sha256:` ref; readable `--at`; optional `--what`/`--why`, trimmed, one line of
1-200 characters); one-append ledger writes with `chg-<n>` ids;
the report's per-cause `changes` counts, `last_at`, top-level
`ledger.entries`, and `--full`-only `change_ids`/`change_refs`; the
`lfm changes` export (`lfm-changes.v1`: `generated_at`, `project`, and per
change `id`, `cause`, `ref`, `at`, `what`, `why`) that other tools join on
`project` + `id`.

## How to get to it (user POV)
After making a recommended change: `lfm change applied --cause <cause>
--ref <sha> --what <text> --why <text>`, then `lfm report` shows it under that
cause and `lfm changes --json` lists it with its what and why.

## Driving it with the public CLI
`test/cli.test.mjs` owns the ledger journey: two changes in separate processes
with the first entry's bytes an exact prefix after the second; every rejected
input (bad cause, `other`, bad ref, bad `--at`, unknown or report-only flag,
missing `--ref`, corrupt existing ledger) exits without touching ledger bytes;
a fresh `report --json` shows the counts and `--full --json` the ids; TOON
decodes equal to JSON; planted record/label/proposal prose never reaches any
output. The same journey owns the export: `changes --json` before ingest is an
empty `lfm-changes.v1`; changes with and without what/why in separate
processes; rejected what/why (empty, blank, 201 characters, newline, control
character, missing value) append nothing and name the rule, never the text;
the `change applied` echo never carries what/why; a corrupt ledger, a
hand-edited entry with bad what/why, or a repeated id exits 1 with `file:line`
and empty stdout; report/change flags are rejected; ids and entries
are unchanged after a later append (a 200-character what is accepted); TOON
decodes equal to JSON; owner what/why markers appear in `changes` but never in
any report output. The helper drives `changes-empty`, `change-applied`,
`changes` and `changes-json` only to capture evidence; with `--package` it
drives `packed-changes` and reruns the suite through the installed bin
(`packed-npm-test`, `LFM_CLI`).

## Gotchas
Single writer is assumed; concurrent writers could repeat an id (a lock file is
the upgrade). New ids are the highest `chg-<n>` + 1; a repeated id is a ledger
problem, so `changes` never exports a duplicate join key. A missing ledger means zero entries; an invalid one exits 1 with
file:line only. What/why are owner-written text meant to leave the privacy
bound only through `changes`; the report never prints them. `generated_at` is
the export time, so compare TOON to JSON without it. No measurement, Helped?
verdicts, rollback, or instruction edits in this slice.
