# Machine surface (help, version, bare command, TOON/JSON/full)

## Sub-features
`--help`/`-h` and `--version`/`-v` without reading config; a bare command (or a
leading flag) runs the report; default TOON output; `--json` under the versioned
`lfm-report.v1` schema; `--full` adds allow-listed evidence ids; a `next:` hint
after every command.

## How to get to it (user POV)
From an installed package: `lfm --help`, `lfm --version`, `lfm` (report),
`lfm --json`, `lfm report --full`, then `lfm report --full --json`.

## Driving it with the public CLI
The helper drives `help`, `version`, `bare`, `report-json` and `report-full` and
decodes `bare.stdout` as TOON: it must equal the `--json` model (`schema:
lfm-report.v1`), and every `--full` cause must carry `record_ids`/`store_row_ids`.
The e2e suite re-decodes TOON, asserts help/version exit 0 with no config, and
checks the `next:` hints text. Exit codes stay `0`/`1`/`2`/`3`.

## Gotchas
The default, `--json` and `--full` outputs are one privacy-bounded projection:
identifiers and counts only. `--full` is not permission to print private evidence.
Next hints go to stderr, never inside the JSON/TOON payload, and never carry
record text. A problem is counted, not echoed: exit 1 with `problems: N`.
