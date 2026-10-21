# Post the report to sign-off

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; after the signoff-post drive the signoff-report drive posts the run's whole report with the fake sign-off-axi, then again as a retry. With `signoff_report: on` in the project config a retro posts it when the run ends and `status` shows `signoff_report`.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi signoff report --dir <staged project> twice with the fake sign-off-axi first on PATH; signoff-report-retry.stdout must say `posted: lfm-report-<run>`, and the fake board must hold one report card with no options beside the Apply/Skip finding cards.
3. Without sign-off-axi on PATH the same command prints `skipped: ...` and exits 0.
4. Capture: signoff-report.stdout, signoff-report-retry.stdout and signoff-board.json in $DONE_DONE_EVIDENCE_ROOT.
5. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
