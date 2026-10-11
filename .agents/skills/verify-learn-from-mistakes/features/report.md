# Report and input errors

## Sub-features
Evidence-backed recommendations, unresolved refs, unread coverage, bad config,
malformed labels and empty input.

## How to get to it (user POV)
Run `lfm report --labels <file> --proposals <file>` after ingest.

## Driving it with the public CLI
Inspect helper report and all three existing `npm test` journeys. Examples show
0 unlabelled, duplicate annotations, gate:step-6 but not step-5, and real refs.
The second journey retains two unread long records, reports missing ref `nope`
and exits 1; malformed JSON exits 2 and names its line; unknown IDs are named;
unknown config key `colour` is rejected. The third journey's empty input exits 3
and says nothing to count. These are driven by the real CLI, not new unit tests.

## Gotchas
An unchecked proposal is explicitly marked, not accepted. Inspect the TAP log
for all three passing journeys, not just npm's process exit. No recommendations
are applied and no release is performed.
