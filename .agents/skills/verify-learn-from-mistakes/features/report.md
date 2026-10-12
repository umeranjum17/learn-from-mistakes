# Report and input errors

## Sub-features
Evidence-backed recommendations, unresolved refs, unread coverage, bad config,
malformed labels and empty input.

## How to get to it (user POV)
Run `lfm` or `lfm report --labels <file> --proposals <file>` after ingest; add
`--json` for JSON and `--full` for evidence ids.

## Driving it with the public CLI
Inspect helper `report`/`report-detail`/`report-json`/`report-full` and the existing
`npm test` journeys. Examples show 0 unlabelled; the one duplicate collapses into
the `shared-cache-lock` counts (3 incidents, 4 records); `--full` ids carry
`gate:step-1` but not `step-5`; and accepted proposal refs appear as ids. The
bad-input journey retains two unread long records (coverage falls), counts the missing
ref `nope` as one problem and exits 1 without printing its text; malformed JSON exits 2
and names its line; unknown IDs count as a problem; unknown config key `colour` is
rejected. The empty-input journey exits 3, says nothing to count and prints a
`next: lfm ingest` hint. These are driven by the real CLI, not new unit tests.

## Gotchas
A problem is counted (`problems: N`), not printed, to keep the output private.
No recommendations are applied and no release is performed.
