# Report and input errors

## Sub-features
Evidence-backed recommendations, unresolved refs, unread coverage, bad config,
malformed labels, empty input, and proposal rules (repeated causes only, with
target and owner, at most five lines).

## How to get to it (user POV)
After a retro whose worker kept labels, a bare `learn-from-mistakes-axi` or `report` counts that run's labels:
`labels_from: run <id>`, `findings[n]{cause,count,days}` in the TOON report, then one `finding: <cause> (<count>/<days> days): <summary>`
line per finding after the summary line, and `next: ... status --run <id>`. `--json` prints the findings as counts only, never the summaries.
If the run's labels have problems, the next hint is `retro --wait`, because only a new run relabels the records.
With no such run, or with `--labels <file>`, it counts `labels.jsonl` (`labels_from: labels.jsonl` or `--labels`).
A run store that sqlite cannot read is one `error:` line with a `next:` hint.
Run `learn-from-mistakes-axi` or `learn-from-mistakes-axi report --labels <file> --proposals <file>` after ingest; add
`--json` for JSON and `--full` for evidence ids.

## Driving it with the public CLI
Inspect helper `report`/`report-detail`/`report-json`/`report-full` and the existing
`npm test` journeys. Examples show 0 unlabelled; the one duplicate collapses into
the `shared-cache-lock` counts (3 incidents, 4 records); `--full` emits non-content
source row ids such as `gate:step-1` but never a content-derived record id, and
proposal refs that are record ids are not echoed as evidence. The
bad-input journey retains two unread long records (coverage falls), counts the missing
ref `nope` as one problem and exits 1 without printing it anywhere (stderr says
`problem: refs.jsonl:1: 1 of 1 refs not found`); malformed JSON exits 1 with `error: <file>:<line>: not valid JSON`;
unknown IDs count as a problem and, like a second label (which names the line of the first),
never echo a record id; with zero labels the `next:` hint is the labelling step and names the absolute `records.jsonl` path; unknown config key `colour` is
rejected. A proposal for a counted-but-unrepeated cause, a missing or blank
target, a missing or blank owner, and a sixth proposal line each exit 1 with
their own `problem: <file>:<line>:` message while the report still prints with
the problem counted; the stock examples still exit 0. The empty-input journey exits 3, says nothing to count and prints a
`next: learn-from-mistakes-axi ingest` hint. These are driven by the real CLI, not new unit tests.

## Gotchas
A problem is counted (`problems: N`) in the report; stderr prints up to 20 `problem:` lines
(file:line and the rule; never a record id or a ref) so the user sees what broke.
No recommendations are applied and no release is performed.
