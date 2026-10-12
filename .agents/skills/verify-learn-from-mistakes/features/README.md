# CLI feature map

| Feature | Public drive | Expected evidence |
| --- | --- | --- |
| [Ingest](ingest.md) | `lfm ingest` | source counts, `sha256` content identity per source (store digest stable across mtime, changes with rows) and retained state; input hashes unchanged |
| [Count](count.md) | `lfm count` before/after labels | separate source totals, duplicate/occurrence arithmetic, unread coverage |
| [Report and errors](report.md) | `lfm report`, bare `lfm`, existing negative journeys | real refs; bad input/empty exits, no fabricated coverage; every rejection is one `error:` line plus `next:`, never the usage block |
| [Applied-change ledger and export](change.md) | `lfm change applied [--what --why]`, `lfm changes [--json]`, `lfm report --json`/`--full` | append-only bytes, per-cause counts and ids, `lfm-changes.v1` with stable ids and owner what/why, what/why and canary absent from the report |
| [Machine surface](surface.md) | `--help`, `--version`, bare command, `--json`, `--full`, TOON default | behavior asserted by `test/cli.test.mjs`: valid TOON equal to the `lfm-report.v1` JSON, non-content ids-only `--full`, a private canary absent from every output and stderr; the helper only captures evidence |
| [Package install](package.md) | helper `--package`; `npm pack` + fresh-prefix install | manifest carries the bin, metadata and standalone skill; the installed bin drives the report and the export, and passes the e2e suite |

Run the helper from `../SKILL.md`; reuse `test/cli.test.mjs`, never duplicate its
journeys in a new test file. Synthetic expectations apply only to `examples`.
The package install journey resolves the declared npm dependencies and may
touch the registry; the default journey starts no network.
