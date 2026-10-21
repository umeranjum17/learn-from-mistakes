# Freeze the five made-up mistakes

Part of the learn-from-mistakes verification map. Source: `scripts/frozen-five.mjs`.

## How to get to it (user POV)

Run the frozen five command: it runs the real retro over five made-up mistakes, in fixed words, once over a plain defect log and once over the same log with a Firstmate home that adds the complaint, and scores each mistake as found, listed or missing. The worker's and the judge's answers are recorded, so the command calls no model and needs no key or network.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. node scripts/frozen-five.mjs --json; the standing must hold the same five cases in both environments, and the case the recorded answer names must be found in each. The unrelated finding the answer also gives must name none of them.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/frozen-five.stdout, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
