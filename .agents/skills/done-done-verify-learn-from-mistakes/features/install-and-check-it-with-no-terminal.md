# Install and check it with no terminal

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Run the cli journey; the setup drives need a fresh project holding only a defect log and the fake agent CLIs, and no terminal at all. They install the tool there with `setup` and then ask `doctor` for the health answer.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. `learn-from-mistakes-axi setup --agent claude --model <model> --judge-agent opencode --judge-model <model> --sessions claude --json --dir <fresh project>` with stdin closed: the script asserts exit 0, `ready: true`, `changed: true`, `fails: 0`, and that `config` and `global` name the written files. Its stdout is in `setup.stdout`.
3. The same command again over the same home and project: the script asserts exit 0, `ready: true`, `changed: false`, `config_status: already set up`, and that the project config and the installed skill are byte-identical afterwards. Its stdout is in `setup-again.stdout`.
4. `learn-from-mistakes-axi doctor --json --dir <fresh project>`: the script asserts exit 0 and `fails: 0` (`setup-doctor.stdout`), then that `setup --agent claude` alone exits 2 and names the flags it needs instead of asking (`setup-missing-flags.stderr`).
5. With `--package`: the script also asserts the packed README still carries the `## For installers` section and its setup command.
6. Capture: the evidence files above are the capture, as SKILL.md's Evidence section says.
7. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
