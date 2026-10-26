# learn-from-mistakes features

The repo's maintained verification map; a proof that drives one entry point is incomplete when this lists others.

- [Run a retro and read its report](run-a-retro-and-read-its-report.md): Run the cli journey (node scripts/verify-journeys.mjs) on the synthetic examples project; the retro drives run in the staged project
- [Read the saved run as JSON](read-the-saved-run-as-json.md): After the retro drive in the cli journey has saved a run
- [Record an applied change and export the ledger](record-an-applied-change-and-export-the-.md): Run the cli journey; the change drives run before any retro that reads the ledger
- [Cancel a running retro](cancel-a-running-retro.md): Start a detached retro in the staged project with the test-only LFM_TEST_SLOW_STEP=report:20000 setting, so the run is still going
- [Print the agent procedure](print-the-agent-procedure.md): Run the cli journey; the guide drive needs no project config
- [Split a full retro bundle into parts](split-a-full-retro-bundle-into-parts.md): Run the cli journey; the retro-parts drive runs a retro over 40 defect lines with `caps.bundle_chars: 1000`
- [Count a captain complaint as a repeated cause](count-a-captain-complaint-as-a-repeated-cause.md): Run the cli journey; the retro-complaint drive runs a retro over one captain chat line
- [Name the records no finding cites](name-records-no-finding-cites.md): Run the cli journey; the retro-uncited drive runs a retro over one captain chat line and two defects, with one finding that cites one defect (`scripts/verify-journeys.mjs`)
- [Freeze the five made-up mistakes](freeze-the-five-made-up-mistakes.md): Run the cli journey; the frozen-five drive scores five made-up mistakes with and without Firstmate sources, with a recorded worker and judge (`scripts/frozen-five.mjs`)
- [Post the report to sign-off](post-the-report-to-sign-off.md): Run the cli journey; the signoff-report drive posts the run's whole report with the fake sign-off-axi, then retries it (`scripts/verify-journeys.mjs`)
- [Keep a learned project skill](keep-a-learned-project-skill.md): Run the cli journey; the retro-skill drives run three retros in a plain git project whose accepted fix targets the project skill (`scripts/verify-journeys.mjs`)
- [Go deep on one incident](go-deep-on-one-incident.md): Run the cli journey; the incident drives run one made-up failure (text, a notes file and a screenshot) in a plain project, then track its fixes with incident --status until a check passes (`scripts/verify-journeys.mjs`)
- [Install and check it with no terminal](install-and-check-it-with-no-terminal.md): Run the cli journey; the setup drives install a fresh project with every choice as a flag, run the same command twice (the second changes no file), then ask doctor --json
- [Show the running version](show-the-running-version.md): Run the cli journey; the version and help drives need no project config, and --package adds the npm install's (`scripts/verify-journeys.mjs`)
- [Fall over when an account hits a limit](fall-over-when-an-account-hits-a-limit.md): Run the cli journey; the account-picker drive uses the stub picker and a fake quota on account A (`scripts/verify-journeys.mjs`)
