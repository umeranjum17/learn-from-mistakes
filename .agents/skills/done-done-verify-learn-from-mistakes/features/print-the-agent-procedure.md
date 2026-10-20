# Print the agent procedure

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the guide drive needs no project config.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Learn-from-mistakes-axi guide, with no project config; the stdout is in guide.stdout.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/print-the-agent-procedure.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
