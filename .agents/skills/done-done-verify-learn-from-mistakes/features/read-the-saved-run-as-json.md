# Read the saved run as JSON

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

After the retro drive in the cli journey has saved a run.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Learn-from-mistakes-axi report --json, and report --full --json, against the staged project; check the evidence files report-json.stdout and report-full.stdout.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/read-the-saved-run-as-json.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
