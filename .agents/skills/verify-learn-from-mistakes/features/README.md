# CLI feature map

| Feature | Public drive | Expected evidence |
| --- | --- | --- |
| [Ingest](ingest.md) | `learn-from-mistakes-axi ingest` | source counts, `sha256` content identity per source (store digest stable across mtime, changes with rows) and retained state; input hashes unchanged |
| [Project state dir](state.md) | `learn-from-mistakes-axi ingest`/`change applied` with no global config, in a git project | `.lfm/` beside the config with a `*` `.gitignore`, clean `git status`, separate state for same-named projects, `state_root` override, an owner `.gitignore` that ignores all of `.lfm` left byte-identical, a deficient one refused |
| [Count](count.md) | `learn-from-mistakes-axi count` before/after labels | separate source totals, duplicate/occurrence arithmetic, unread coverage |
| [Report and errors](report.md) | `learn-from-mistakes-axi report`, bare `learn-from-mistakes-axi`, existing negative journeys | real refs; bad input/empty exits, proposal rules (repeated causes only, target/owner, at most five), no fabricated coverage; every rejection is one `error:` line plus `next:`, never the usage block |
| [Applied-change ledger and export](change.md) | `learn-from-mistakes-axi change applied [--what --why]`, `learn-from-mistakes-axi changes [--json]`, `learn-from-mistakes-axi report --json`/`--full` | append-only bytes, per-cause counts and ids, `lfm-changes.v1` with stable ids and owner what/why, what/why and canary absent from the report |
| [Machine surface](surface.md) | `--help`, `--version`, bare command, `--json`, `--full`, TOON default | behavior asserted by `test/cli.test.mjs`: valid TOON equal to the `lfm-report.v1` JSON, non-content ids-only `--full`, a private canary absent from every output and stderr; the helper only captures evidence |
| [Config v2 and source registry](config.md) | `.learn-from-mistakes.yaml` with v2 keys, then `learn-from-mistakes-axi retro --foreground` | v1 configs unchanged; every v2 key loads (2 completed steps); a bad key or value such as `worker: { runner: 3 }` exits 2 naming the key; sources read through `src/sources/<type>.mjs` |
| [Saved runs](run.md) | `learn-from-mistakes-axi retro [--wait <time> \| --foreground]`, `status`, `runs`, `rerun --resume` | a completed run with 2 step rows in `.lfm/lfm.sqlite`, shown by `status` and `runs`; `.lfm` git-ignored; a failed step exits 1 with its error saved; a detached run outlives its shell; a killed worker shows `interrupted` and `rerun --resume` completes it without running the completed step again |
| [Package install](package.md) | helper `--package`; `npm pack` + fresh-prefix install | manifest carries the bin, metadata and standalone skill; the installed bin drives the report and the export, and passes the e2e suite |
| [Agent skill](skill.md) | `npm run build:skill -- --check`; local-registry `npx -y learn-from-mistakes-axi`; `npx skills add` + clean agent session | check passes then fails on a one-char edit; npx help/guide/journey; the agent loads the skill unprompted and reports a repeated cause |

Run the helper from `../SKILL.md`; reuse `test/cli.test.mjs`, never duplicate its
journeys in a new test file. Synthetic expectations apply only to `examples`.
The package install journey resolves the declared npm dependencies and may
touch the registry; the default journey starts no network.
