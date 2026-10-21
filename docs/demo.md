# The demo is a real report

[Back to the quick start](../README.md)

The images show excerpts of `report.txt` saved by **learn-from-mistakes-axi 0.4.1**, installed from npm on 21 October 2026. They are not invented terminal output or a proposed product interface.

The CLI read only the three made-up defect records below. Claude Code, with the model id `claude-sonnet-5-5`, ran both the worker and judge with tools off. The run completed. It labelled all three records and found repeat causes across three days. **No proposed fix passed the rules.** The judge weakened one finding. A real model may reach a different result on another run.

## Made-up input

The fixture was for Umer. It contained no real project, chat, session or task data.

```markdown
# Demo defect log — synthetic data for Umer

## 2026-10-20

- [tests] The checkout change shipped before the integration check ran. The check found a missing tax field. Rework cost 20 minutes.

## 2026-10-19

- [tests] The invoice change shipped before the integration check ran. The check found a missing currency field. Rework cost 25 minutes.

## 2026-10-18

- [tests] The refund change shipped before the integration check ran. The check found a missing total field. Rework cost 15 minutes.
```

Only a `markdown-log` source pointing to this file was configured. The run used a task-private `LFM_HOME` and a separate fixture directory. It did not read a Firstmate home or agent sessions. No fixes were applied and nothing was posted to an integration.

## What the screenshots show

- [Wide excerpt](media/retro-demo.webp): sections 4–6 of the saved report, unchanged.
- [Phone excerpt](media/retro-demo-mobile.webp): section 4 of the same report, unchanged, wrapped to a narrower width.

The text was displayed in a simple local browser viewer and captured with chrome-devtools-axi. The viewer adds the `report.txt · excerpt` label, typography and background; it adds no findings, counts, evidence or verdicts. These are screenshots of the CLI's saved output, not of an interactive terminal. The earlier screenshots remain in the [reference](reference.md).

This example proves that this run read the fixture and saved a report. It does not prove that every repeated cause is distinct, that a fix was accepted, or that the same models will produce the same answer for your project.
