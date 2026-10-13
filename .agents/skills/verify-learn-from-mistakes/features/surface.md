# Machine surface (help, version, bare command, TOON/JSON/full)

## Sub-features
`--help`/`-h`, `guide` (the agent procedure) and `--version`/`-v` without reading config; a bare command (or a
leading flag) runs the report; default TOON output; `--json` under the versioned
`lfm-report.v1` schema; `--full` adds allow-listed non-content ids (source row ids; change ids live in [change.md](change.md)); a
`next:` hint after every working command (stdout for `--help` and `guide`).

## How to get to it (user POV)
From an installed package: `learn-from-mistakes-axi --help`, `learn-from-mistakes-axi --version`, `learn-from-mistakes-axi` (report),
`learn-from-mistakes-axi --json`, `learn-from-mistakes-axi report --full`, then `learn-from-mistakes-axi report --full --json`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the behavioral assertions: help/version exit 0 with no
config, default TOON decoding to the same `lfm-report.v1` model as `--json`,
`--full` carrying only non-content ids (ledger change ids included, see [change.md](change.md)), and both `next:` hint chains (`report ->
--full -> --full --json` and `report --json -> --full --json`) with `--full
--json` terminating. The helper drives `bare`, `report-json`, `report-full` and
`report-detail` (`--full` alone) only to capture their real stdout/stderr as
evidence; it does not duplicate those assertions. Exit codes stay `0`/`1`/`2`/`3`.

Rejected input: the journey `every rejected input names what was wrong and a next step, never
the whole usage` drives each bad command, option, flag scope, missing value, cause (`other`, unknown,
over 80 characters, control character), `--ref`, `--at`, `--what`, a missing config (prints a minimal
config) and a malformed labels line, asserting the exit code, the `error:` line, the `next:` line and
that stderr never holds the usage block. For the packed proof, drive the same inputs with the
installed bin and keep the transcript (`learn-from-mistakes-axi <bad input>; echo exit=$?`). Ingest with no causes
configured prints `next: no causes configured: ...`.

## Gotchas
The report's `--json` output is one privacy-bounded projection: identifiers, counts and each finding's judge verdict word.
The default (TOON) and `--full` reports add one `finding:` line per finding with the worker's redacted one-line summary (the separate `changes` export carries owner-written `what`/`why`, see [change.md](change.md)). `--full` is not permission to print private evidence.
Next hints go to stderr, never inside the JSON/TOON payload, and never carry
record text. A problem is counted, not echoed: exit 1 with `problems: N`.
