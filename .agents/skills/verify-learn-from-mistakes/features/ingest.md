# Ingest

## Sub-features
Read markdown bullets and failed SQLite rows, retain per-source metadata.
Each source's identity is a sha256 of its content: the log file's text, or the
failed-step rows read from the store (not the database file, not its mtime).

## How to get to it (user POV)
Configure `.learn-from-mistakes.yaml`; run `learn-from-mistakes-axi ingest --dir <project>`.

## Driving it with the public CLI
The helper's `ingest.stdout` must show 13 log items and 5 gate items for examples.
Inspect retained records/rows/sources metadata and matching before/after SHA256
manifests, including the original SQLite file and config/labels/proposals.
Both sources print `sha256 <12 hex>`; `sources.json` keeps the full 64-hex hash.
Store identity is asserted by the `test/cli.test.mjs` journey
`ingest identifies the store by the rows it read, not its mtime, and never writes the store`:
on a copy of `gate.sqlite`, a new mtime keeps the digest, a changed completed step
keeps it, one changed failed-step error with the mtime restored changes it, and the
file's sha256 is identical before and after every ingest. `--package` reruns it
through the installed bin (`packed-npm-test`).

## Gotchas
A missing or unreadable store exits 2 with `next: remove the <id> source or point its path at
your no-mistakes state.sqlite` (journey `an unreadable source or input file is a usage error`).
The store digest covers only the columns the fixed query selects for failed
steps, including their run's branch: a non-failed step or an unselected column
keeps it, by design. It is not a file-byte hash;
read-only proof still uses the evidence SHA256 manifests.
Private runs use caller-owned baselines and offline stores without sidecars.
