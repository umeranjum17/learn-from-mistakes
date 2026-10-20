# learn-from-mistakes features

The repo's maintained verification map; a proof that drives one entry point is incomplete when this lists others.

- [Run a retro and read its report](run-a-retro-and-read-its-report.md): Run the cli journey (node scripts/verify-journeys.mjs) on the synthetic examples project; the retro drives run in the staged project
- [Read the saved run as JSON](read-the-saved-run-as-json.md): After the retro drive in the cli journey has saved a run
- [Record an applied change and export the ledger](record-an-applied-change-and-export-the-.md): Run the cli journey; the change drives run before any retro that reads the ledger
- [Cancel a running retro](cancel-a-running-retro.md): Start a detached retro in the staged project with the test-only LFM_TEST_SLOW_STEP=report:20000 setting, so the run is still going
- [Print the agent procedure](print-the-agent-procedure.md): Run the cli journey; the guide drive needs no project config
