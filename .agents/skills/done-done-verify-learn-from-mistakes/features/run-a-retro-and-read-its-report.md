# Run a retro and read its report

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey (node scripts/verify-journeys.mjs) on the synthetic examples project; the retro drives run in the staged project.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. Learn-from-mistakes-axi retro --foreground, then report, then report --full, with --dir set to the staged project; the stdout and stderr land in the evidence folder as retro.stdout, report.stdout and report-detail.stdout.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/run-a-retro-and-read-its-report.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
