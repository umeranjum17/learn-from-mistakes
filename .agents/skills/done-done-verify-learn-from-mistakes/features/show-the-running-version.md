# Show the running version

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the version and help drives need no project config. The package journey (`--package`) adds the npm install's packed-version and packed-help drives.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. learn-from-mistakes-axi --version and --help from this checkout; the stdout is in version.stdout and help.stdout. The script asserts `<version> (pre-release, from source)` and a help header `learn-from-mistakes-axi <version> (pre-release, from source)`.
3. With --package: the same two from the npm install, in packed-version.stdout and packed-help.stdout; the script asserts the plain `<version>` in both.
4. Capture: save the output and exit status to $DONE_DONE_EVIDENCE_ROOT/show-the-running-version.txt, as SKILL.md's Evidence section says.
5. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
