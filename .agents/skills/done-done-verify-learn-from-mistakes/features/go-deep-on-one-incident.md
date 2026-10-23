# Go deep on one incident

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the incident drives run in a made-up plain project (`incident`) with one failure in Umer's words, a notes file and a screenshot, and an AGENTS.md rule file.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi incident "<the failure>" --evidence notes.md --evidence board.png --foreground --json: incident.stdout is a completed run of kind incident with two numbered fixes, and report-incident.txt holds the eight sections (short answer, timeline, why it happened, why no check caught it, how to avoid it now, the fixes each with an owner, a priority and a due date, not checked, next steps), with the screenshot named under Not checked.
3. incident --status --json: incident-status-open.stdout lists both fixes as open.
4. change applied --proposal <run>:2 --ref abc1234, then make the rule fix in AGENTS.md and run incident --status --json again: incident-status-done.stdout shows one fix done (its check passed) and one still open.
5. Capture: save the files above to $DONE_DONE_EVIDENCE_ROOT, as SKILL.md's Evidence section says.
6. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
