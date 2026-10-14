# Report and input errors

## Sub-features
The last completed run's counts, coverage, findings, fixes and follow-ups; bad config.

## How to get to it (user POV)
After a retro whose worker kept labels, `report` counts that run's labels (`lfm-report.v2`): `run: <id>`, `report_txt: <path>`,
that run's `metrics`, `followups` and `fixes` as `status` shows them, `findings[n]{cause,count,days,verdict}` in the TOON report, then one `finding: <cause> (<count>/<days> days, <verdict>)`
line per finding after the summary line, and `next: ... status --run <id>`. `--json` prints the findings as counts and verdict words; the summaries are in `report.txt` only.
If the run's labels have problems, the next hint is `retro --wait`, because only a new run relabels the records.
With no completed run it exits 3 with `next: learn-from-mistakes-axi retro --wait 8m`.
The bare `learn-from-mistakes-axi` shows the last run (any status) and its `summary` line, then `next: ... report`.
A run store that sqlite cannot read is one `error:` line with a `next:` hint.
Add `--json` for JSON and `--full` for evidence ids.

## Driving it with the public CLI
Inspect helper `report-no-run` (exit 3), `report`/`report-detail`/`report-json`/`report-full`
after the first retro, and the existing `npm test` journeys: `--full` emits non-content
source row ids such as `gate:step-1` but never a content-derived record id; unknown
config key `colour` is rejected.

## Gotchas
A problem is counted (`problems: N`) in the report; stderr prints up to 20 `problem:` lines
(the rule; never a record id or a ref) so the user sees what broke.
No recommendations are applied and no release is performed.
