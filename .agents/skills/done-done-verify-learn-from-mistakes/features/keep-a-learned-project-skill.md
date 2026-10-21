# Keep a learned project skill

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the retro-skill drives run three retros in a made-up plain git project (`learned`) whose defect log has cache-lock defects 5 days ago and today, with the fake worker aiming its fixes at `.agents/skills/learn-from-mistakes-learned/SKILL.md`.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi retro --foreground --json, then apply --fix 1: the branch adds the skill (skill-created.md holds its rule, every evidence pointer, the fix id and its metric) and the work tree is untouched.
3. Merge that branch (backdated 3 days, with the ledger entry backdated 4 days), then retro again: retro-skill-measured.stdout measures chg-1 at 4 before, 3 after, verdict fix, and skill-measured.diff changes only that skill's `Result:` line, on lfm/learned-e3b0c4/<run>-skill.
4. Merge it, add 3 more defects, then retro again: retro-skill-retired.stdout gives rollback and skill-retired.txt shows the skill deleted on that run's skill branch.
5. Capture: save the files above to $DONE_DONE_EVIDENCE_ROOT, as SKILL.md's Evidence section says.
6. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
