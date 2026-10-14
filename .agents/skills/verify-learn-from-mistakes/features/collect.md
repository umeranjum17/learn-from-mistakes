# Collect step: sources and counts

## Sub-features
A retro's `collect` step reads markdown bullets, failed SQLite rows and a github source's merged PRs into `.lfm/sources.json`.
Counts: duplicates collapse, `occurrences` add, log and store totals are never added, an undated store row is never a day.
Each source's identity is a sha256 of its content: the log file's text, or the
failed-step rows of this repo read from the store (not the database file, not its mtime).

## How to get to it (user POV)
Configure `.learn-from-mistakes.yaml`; run `learn-from-mistakes-axi retro --dir <project>`. State
goes to `<project>/.lfm` (see [state.md](state.md)).

## Driving it with the public CLI
The helper's `retro` logs show 13 log items and 5 gate items for examples.
Inspect retained records/rows/sources metadata and matching before/after SHA256
manifests, including the original SQLite file and config; `sources.json` keeps each 64-hex hash.
Store identity is asserted by the `test/cli.test.mjs` journey
`a retro identifies the store by the rows it read, not its mtime, and never writes the store`:
on a copy of `gate.sqlite`, a new mtime keeps the digest, a changed completed step
keeps it, one changed failed-step error with the mtime restored changes it, and the
file's sha256 is identical before and after every retro. `--package` reruns it
through the installed bin (`packed-npm-test`).

## Gotchas
The store holds every gated repo; only this project's failed steps are read (its `repos` row by checkout path or `origin`, or a git worktree of it; a store missing a table or column the read uses exits 2 `unknown store schema (no <table>.<column>)`). A copy of `gate.sqlite` needs its `repos.working_path` set to the copy, as the helper and the journeys do.
A missing or unreadable source fails `collect` (exit 1, never the path) and is a `doctor` fail with its `fix:`.
The store digest covers the rows the fixed query selects for this repo's failed
steps, as read (redacted error, cause tag, their run's branch): a non-failed step,
another repo's row or an unselected column keeps it, by design. It is not a file-byte hash;
read-only proof still uses the evidence SHA256 manifests.
Private runs use caller-owned baselines and offline stores without sidecars.
