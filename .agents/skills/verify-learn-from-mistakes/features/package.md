# Package install (npm pack + fresh-prefix install)

## Sub-features
A minimal installable single-bin package that carries its standalone skill and
public package metadata; a fresh prefix installs the exact packed tarball and its
real `learn-from-mistakes-axi` bin drives the report and a saved run.

## How to get to it (user POV)
`npm pack`, then `npm install -g --prefix <fresh> <tarball>`, then run
`<fresh>/bin/learn-from-mistakes-axi --help` / `--version` / `report --json`.

## Driving it with the public CLI
Run the helper with `--package`:
`node .agents/skills/verify-learn-from-mistakes/verify.mjs <evidence> --package`.
It records `pack.json`, `pack.manifest.txt` and the packed-command logs. The
manifest must include `package/bin/learn-from-mistakes-axi.mjs`, `package/src/config.mjs`, `package/src/sources/markdown-log.mjs`, `package/src/sources/no-mistakes.mjs`, `package/src/run.mjs`, `package/src/store.mjs`, `package/package.json` and the skill,
and must exclude `test`/`examples`. The installed bin's `report --json` must be
`lfm-report.v1`, its `changes --json` must be `lfm-changes.v1`, its
`retro --wait 1m --json` must be a `completed` run with 2 steps, run by the worker the installed bin spawns (`packed-retro`), the whole
`npm test` suite must pass again with `LFM_CLI` set to the installed bin
(`packed-npm-test`), and the packaged skill file must exist in the installed prefix.

## Gotchas
This is the only journey that resolves the declared dependencies, so it uses the
isolated npm cache and may touch the registry. `npm pack`/install never publishes:
first publish is the captain's own test. The tarball and its sha256 are retained
as evidence; no release or account is created.
