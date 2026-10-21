# Name the records no finding cites

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the retro-uncited drive runs a retro over a made-up Firstmate home with one captain chat line plus a defect log with two defects, with the fake worker naming one finding that cites only the older defect.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi retro --foreground --json --dir <uncited project> with FAKE_ANALYSE=label and FAKE_FINDINGS=last; report-uncited.txt (section 6 of the run's report.txt) must say `No finding cites 1 captain complaint.` and `No finding cites 1 defect record.`, each with an Evidence pointer, and must not point at the cited defect. With `excerpts: on` each record also shows a `Text:` line with its own words, cut to 100 characters (this journey sets `excerpts: off`, so it must show none); the defect the fake worker labelled other says `The worker labelled it other`.
3. Capture: save the section to $DONE_DONE_EVIDENCE_ROOT/report-uncited.txt, as SKILL.md's Evidence section says.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
