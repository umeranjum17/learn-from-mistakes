# Split a full retro bundle into parts

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the retro-parts drive runs a retro in a made-up project with 40 defect lines and `caps.bundle_chars: 1000`.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi retro --foreground --json --dir <parts project> with the fake agent; the bundle.md of the run must hold more than one part ("# Retro bundle (part n of m)"), each part at most 1000 characters, all 40 defect records and no "Dropped" line.
3. Capture: save the run output to $DONE_DONE_EVIDENCE_ROOT/retro-parts.stdout and the bundle to $DONE_DONE_EVIDENCE_ROOT/bundle-parts.md, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
