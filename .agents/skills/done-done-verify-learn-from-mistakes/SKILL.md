---
name: "done-done-verify-learn-from-mistakes"
description: "Drive the learn-from-mistakes CLI: learn-from-mistakes-axi, driven through the repo's own verify script (scripts/verify-journeys.mjs) over its synthetic examples project. the way a user does and capture proof it works. Use when proving a learn-from-mistakes change, capturing evidence, or keeping the feature map honest."
---

# done-done-verify-learn-from-mistakes

Written by `done-done init` through claude from this repo's own files (surface: CLI: learn-from-mistakes-axi, driven through the repo's own verify script (scripts/verify-journeys.mjs) over its synthetic examples project.). The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.

## Launch

node scripts/verify-journeys.mjs "$DONE_DONE_EVIDENCE_ROOT"

Safe: This is the repo's cli journey in .done-done.yaml, which runs this script with DONE_DONE_EVIDENCE_ROOT set to a fresh folder. The script stages copies of the examples/ project, sets HOME, TMPDIR, XDG, LFM_HOME, SIGN_OFF_HOME, LFM_TEST_MODE and LFM_TEST_BOARD_ROOT to a temporary scratch dir, puts only the repo's fake agent (test/fake-agent/claude) on PATH, and writes synthetic sessions, so no real account, paid service or the owner's state is touched. node_modules must already exist (the journey's npm ci step installs it first) (from `scripts/verify-journeys.mjs`).

Ready: The script runs to completion with exit code 0, and the evidence folder holds commands.json and identity.json. Each drive's status is listed in commands.json; the script's own assertions fail the run if one is wrong. Tear down what you started; never kill by process name.
Isolation: Each run gets its own new, empty DONE_DONE_EVIDENCE_ROOT folder, and the script refuses one that is not new or that overlaps the checkout. Its scratch dir (mkdtemp under the temp dir) holds a private HOME, TMPDIR, XDG dirs, SIGN_OFF_HOME and a staged copy of the project, removed on exit. Test-mode posts outside that temp board root are refused. The script copies the example sources and never writes to them, and it never drives the owner's sessions, accounts or ~/.learn-from-mistakes config.
When the repo's .done-done.yaml has an instance block, done-done already runs the app at $DONE_DONE_BASE_URL (its own port and HOME): BASE is then that URL, never a hard-coded port.

## Drive

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed. Drive through the repo's real handles that each feature file names:

- [Run a retro and read its report](features/run-a-retro-and-read-its-report.md): Run the cli journey (node scripts/verify-journeys.mjs) on the synthetic examples project; the retro drives run in the staged project (`scripts/verify-journeys.mjs`)
- [Read the saved run as JSON](features/read-the-saved-run-as-json.md): After the retro drive in the cli journey has saved a run (`scripts/verify-journeys.mjs`)
- [Record an applied change and export the ledger](features/record-an-applied-change-and-export-the-.md): Run the cli journey; the change drives run before any retro that reads the ledger (`scripts/verify-journeys.mjs`)
- [Cancel a running retro](features/cancel-a-running-retro.md): Start a detached retro in the staged project with the test-only LFM_TEST_SLOW_STEP=report:20000 setting, so the run is still going (`scripts/verify-journeys.mjs`)
- [Print the agent procedure](features/print-the-agent-procedure.md): Run the cli journey; the guide drive needs no project config (`scripts/verify-journeys.mjs`)
- [Split a full retro bundle into parts](features/split-a-full-retro-bundle-into-parts.md): Run the cli journey; the retro-parts drive runs a retro over 40 defect lines with `caps.bundle_chars: 1000` (`scripts/verify-journeys.mjs`)
- [Count a captain complaint as a repeated cause](features/count-a-captain-complaint-as-a-repeated-cause.md): Run the cli journey; the retro-complaint drive runs a retro over one captain chat line (`scripts/verify-journeys.mjs`)
- [Name the records no finding cites](features/name-records-no-finding-cites.md): Run the cli journey; the retro-uncited drive runs a retro over one captain chat line and two defects, with one finding that cites one defect (`scripts/verify-journeys.mjs`)
- [Freeze the five made-up mistakes](features/freeze-the-five-made-up-mistakes.md): Run the cli journey; the frozen-five drive scores five made-up mistakes with and without Firstmate sources, with a recorded worker and judge (`scripts/frozen-five.mjs`)
- [Read the project's own context](features/project-context.md): Run the cli journey; the retro-context drive runs a retro over a made-up project with a rule, a secret file and a file over the cap (`scripts/verify-journeys.mjs`)
- [Post the report to sign-off](features/post-the-report-to-sign-off.md): Run the cli journey; the signoff-report drive posts the run's whole report with the fake sign-off-axi, then retries it (`scripts/verify-journeys.mjs`)
- [Keep a learned project skill](features/keep-a-learned-project-skill.md): Run the cli journey; the retro-skill drives run three retros in a plain git project whose accepted fix targets the project skill (`scripts/verify-journeys.mjs`)
- [Go deep on one incident](features/go-deep-on-one-incident.md): Run the cli journey; the incident drives run one made-up failure (text, a notes file and a screenshot) in a plain project, then track its fixes with incident --status until a check passes (`scripts/verify-journeys.mjs`)
- [Install and check it with no terminal](features/install-and-check-it-with-no-terminal.md): Run the cli journey; the setup drives install a fresh project with every choice as a flag, run the same command twice (the second changes no file), then ask doctor --json (`scripts/verify-journeys.mjs`)
- [Show the running version](features/show-the-running-version.md): Run the cli journey; the version and help drives need no project config, and --package adds the npm install's (`scripts/verify-journeys.mjs`)
- [Fall over when an account hits a limit](features/fall-over-when-an-account-hits-a-limit.md): Run the cli journey; the account-picker drive uses the stub picker and a fake quota on account A (`scripts/verify-journeys.mjs`)

## Evidence

What to capture: Evidence folder files: commands.json (each drive's name, args, env and exit status), <name>.stdout and <name>.stderr for each drive (for example retro-v2.stdout, report-json.stdout, changes-json.stdout, abort.stdout), identity.json (repo HEAD, dirty state, and sha256 of each candidate file), and inputs.before.json (sha256 of each input before the run). The exit code and these files are the proof. Exercise the real user path, not internal setters; done-done's judge checks every capture in the run folder against the outcome, so save only captures of the resulting state there and keep any of earlier steps outside it; verify side effects alongside what is visible. Evidence goes to the run folder `done-done run` prints.

## Cleanup

Stop the instances this run started and remove scratch state. Evidence survives cleanup: never delete the run folder.
