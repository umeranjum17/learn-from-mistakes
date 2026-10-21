# Record an applied change and export the ledger

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the change drives run before any retro that reads the ledger.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Learn-from-mistakes-axi change applied --cause server-memory-kill --ref abc1234 --at 2026-01-02T03:04:05Z --metric cause_count:server-memory-kill --tripwire "<= 0" --kind rule --what <text> --why <text>, then learn-from-mistakes-axi changes --json; the drive changes-json.stdout must show the metric, tripwire, kind and check command (the retro that measures it, when none is given).
2a. `change applied --proposal <run>:<n>` (drive change-proposal) must copy the fix's own check command (`npm test` in the fake worker's fixes) and the proposal into the ledger entry. The retro-followup drive's followups must show proposal checked, fix applied, fix shipped and fix worked apart (rolled back: worked `no`; no data: `not yet`), and report.txt section 3 prints them with the check command.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/record-an-applied-change-and-export-the-.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
