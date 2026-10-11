# Ingest

## Sub-features
Read markdown bullets and failed SQLite rows, retain per-source metadata.

## How to get to it (user POV)
Configure `.learn-from-mistakes.yaml`; run `lfm ingest --dir <project>`.

## Driving it with the public CLI
The helper's `ingest.stdout` must show 13 log items and 5 gate items for examples.
Inspect retained records/rows/sources metadata and matching before/after SHA256
manifests, including the original SQLite file and config/labels/proposals.

## Gotchas
SQLite CLI metadata reports mtime, not byte identity; use the evidence hashes.
Private runs use caller-owned baselines and offline stores without sidecars.
