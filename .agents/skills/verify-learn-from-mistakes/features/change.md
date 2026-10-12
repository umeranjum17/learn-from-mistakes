# Applied-change ledger

## Sub-features
`lfm change applied` validation (cause key, never `other`; git-sha or
`sha256:` ref; readable `--at`); one-append ledger writes with `chg-<n>` ids;
the report's per-cause `changes` counts, `last_at`, top-level
`ledger.entries`, and `--full`-only `change_ids`/`change_refs`.

## How to get to it (user POV)
After making a recommended change: `lfm change applied --cause <cause>
--ref <sha>`, then `lfm report` shows it under that cause.

## Driving it with the public CLI
`test/cli.test.mjs` owns the ledger journey: two changes in separate processes
with the first entry's bytes an exact prefix after the second; every rejected
input (bad cause, `other`, bad ref, bad `--at`, unknown or report-only flag,
missing `--ref`, corrupt existing ledger) exits without touching ledger bytes;
a fresh `report --json` shows the counts and `--full --json` the ids; TOON
decodes equal to JSON; planted record/label/proposal prose never reaches any
output. The helper does not duplicate these assertions.

## Gotchas
Single writer is assumed; concurrent writers could repeat an id (a lock file is
the upgrade). A missing ledger means zero entries; an invalid one exits 1 with
file:line only. No measurement, rollback, or instruction edits in this slice.
