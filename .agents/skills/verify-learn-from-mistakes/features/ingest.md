# Ingest

## Sub-features
Read markdown bullets and failed SQLite rows, retain per-source metadata.
Each source's identity is a sha256 of its content: the log file's text, or the
failed-step rows read from the store (not the database file, not its mtime).

## How to get to it (user POV)
Configure `.learn-from-mistakes.yaml`; run `lfm ingest --dir <project>`.

## Driving it with the public CLI
The helper's `ingest.stdout` must show 13 log items and 5 gate items for examples.
Inspect retained records/rows/sources metadata and matching before/after SHA256
manifests, including the original SQLite file and config/labels/proposals.
Both sources print `sha256 <12 hex>`; `sources.json` keeps the full 64-hex hash.
Store identity is asserted by the `test/cli.test.mjs` journey "ingest identifies
the store by the rows it read": on a copy of `gate.sqlite`, a new mtime keeps the
digest, one changed failed-step error with the mtime restored changes it, and the
file's sha256 is identical before and after every ingest. `--package` reruns it
through the installed bin (`packed-npm-test`).

## Gotchas
The store digest covers only the failed-step rows lfm reads: a change to a
completed step or another table keeps it, by design. It is not a file-byte hash;
read-only proof still uses the evidence SHA256 manifests.
Private runs use caller-owned baselines and offline stores without sidecars.
