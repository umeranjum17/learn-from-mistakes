# Count a captain complaint as a repeated cause

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the retro-complaint drive runs a retro over a made-up Firstmate home whose data/chat.tsv holds one captain chat line, with the fake worker labelling it as the cause nested-scroll.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi retro --foreground --dir <chat project> with FAKE_ANALYSE=label and FAKE_CAUSE=nested-scroll; retro-complaint.stdout must say `repeated: nested-scroll (1 time/1 day)` although the repeat rule asks for 3 incidents on 2 days.
3. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/retro-complaint.stdout, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
