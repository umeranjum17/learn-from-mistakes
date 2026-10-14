# Removed manual flow and the guide

`ingest`, `count`, `report --labels` and `report --proposals` exit 2 with `error: <x> was removed: a retro ...` and
`next: learn-from-mistakes-axi retro --wait 8m`; `report` before any completed run exits 3; `guide` prints the skill's steps
([skill.md](skill.md)). Helper logs: `guide`, `removed-*`, `report-no-run`, `packed-guide`; asserted in `test/cli.test.mjs`.
