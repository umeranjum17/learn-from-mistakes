# Plain-text report (report.txt)

## Sub-features
The report step of each completed run writes `.lfm/runs/<id>/report.txt` for a person, in seven sections:
short answer (3 lines), numbers (each metric with data or a target: this window, last window, target, met or missed),
last changes (each follow-up's before, after, verdict, what to do and the worker's reason), repeated mistakes
(cause, count, days, evidence), fixes (at most 5: finding, owner, change, metric and target, tripwire, the judge's
verdict and note, evidence), not checked (sources with no records, skipped sessions, bundle items dropped, labels
and fixes the rules left out, items the judge weakened or did not check) and questions for you.

## How to get to it (user POV)
`learn-from-mistakes-axi retro --foreground` (or `--wait`), then read the file. The `report` step log ends with
`report.txt: <lines> lines, <questions> questions`. A fix's change and the judge's note are only in `report.txt`;
a finding's summary also prints in `retro` and `status` `result`.

## Driving it with the public CLI
The helper's `retro-propose` saves `report.txt` to the evidence dir and checks the seven sections, the Apply or Skip
question for fix 1 and the roll-back question for `chg-2`. `test/cli.test.mjs` checks every sentence has at most 20
words, no path or store id is outside an `Evidence:` line, each pointer opens (a project file line, a gate store row,
a session event), the `signoff post` line when `sign-off-axi` is on PATH, and the canary journey: a canary in each
agent-written field reaches `report.txt` and the finding summary in `status`, never stderr or a step log.

## Gotchas
Agent or config text that breaks the 20-word rule or names a path, file, bundle id or hash is replaced by a line
that says it is not shown. Pointers:
`file:line` (relative to the project), `<store> step_results row <id>`, `session <id> at <time>`, `PR #N`.
