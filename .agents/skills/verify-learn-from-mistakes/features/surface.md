# Machine surface (help, version, bare command, TOON/JSON/full)

## Sub-features
`--help`/`-h` and `--version`/`-v` without reading config; a bare command (or a
leading flag) runs the report; default TOON output; `--json` under the versioned
`lfm-report.v1` schema; `--full` adds allow-listed non-content ids (source row ids; change ids live in [change.md](change.md)); a
`next:` hint after every command.

## How to get to it (user POV)
From an installed package: `lfm --help`, `lfm --version`, `lfm` (report),
`lfm --json`, `lfm report --full`, then `lfm report --full --json`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the behavioral assertions: help/version exit 0 with no
config, default TOON decoding to the same `lfm-report.v1` model as `--json`,
`--full` carrying only non-content ids (ledger change ids included, see [change.md](change.md)), and both `next:` hint chains (`report ->
--full -> --full --json` and `report --json -> --full --json`) with `--full
--json` terminating. The helper drives `bare`, `report-json`, `report-full` and
`report-detail` (`--full` alone) only to capture their real stdout/stderr as
evidence; it does not duplicate those assertions. Exit codes stay `0`/`1`/`2`/`3`.

## Gotchas
The report's default, `--json` and `--full` outputs are one privacy-bounded projection:
identifiers and counts only (the separate `changes` export carries owner-written `what`/`why`, see [change.md](change.md)). `--full` is not permission to print private evidence.
Next hints go to stderr, never inside the JSON/TOON payload, and never carry
record text. A problem is counted, not echoed: exit 1 with `problems: N`.
