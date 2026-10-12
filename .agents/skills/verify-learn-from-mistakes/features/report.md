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
the `shared-cache-lock` counts (3 incidents, 4 records); `--full` emits non-content
source row ids such as `gate:step-1` but never a content-derived record id, and
proposal refs that are record ids are not echoed as evidence. The
bad-input journey retains two unread long records (coverage falls), counts the missing
ref `nope` as one problem and exits 1 without printing it on stdout (stderr names it on a
`problem: refs.jsonl:1:` line); malformed JSON exits 1 with `error: <file>:<line>: not valid JSON`;
unknown IDs count as a problem and a second label names only the line of the first, never the real
record id; with zero labels the `next:` hint is the labelling step; unknown config key `colour` is
rejected. The empty-input journey exits 3, says nothing to count and prints a
`next: lfm ingest` hint. These are driven by the real CLI, not new unit tests.

## Gotchas
A problem is counted (`problems: N`) in the report; stderr prints up to 20 `problem:` lines
(file:line, the rule, and only non-record ids) so the user sees what broke.
No recommendations are applied and no release is performed.
