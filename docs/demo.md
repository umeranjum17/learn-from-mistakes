# The demo is a real report

[Back to the quick start](../README.md)

The images show excerpts of `report.txt` saved by the `learn-from-mistakes-axi` CLI (package version 0.4.1) run from this repository on 21 October 2026. They are not invented terminal output or a proposed product interface.

The CLI read only the six made-up defect records below. Claude Code, with the model id `claude-sonnet-5-5`, ran both the worker and judge with tools off. The run completed. It labelled all six records and found one repeated cause across four days. **One fix passed the rules.** A second fix for the same cause also passed; the images show the first. A real model may reach a different result on another run.

## Made-up input

The fixture was for Umer. It contained no real project, chat, session or task data.

```markdown
# Demo defect log — synthetic data for Umer

## 2026-10-20

- [tests] The checkout change was merged before the integration check ran. The check later failed on a missing tax field. Rework cost 20 minutes.
- [tests] The refund change was merged before the integration check ran. The check later failed on a missing total field. Rework cost 15 minutes.

## 2026-10-19

- [tests] The invoice change was merged before the integration check ran. The check later failed on a missing currency field. Rework cost 25 minutes.
- [tests] The review note said the integration check is not part of the merge checklist, so nobody waited for it.

## 2026-10-18

- [tests] The coupon change was merged before the integration check ran. The check later failed on a rounding error. Rework cost 30 minutes.

## 2026-10-17

- [tests] The shipping change was merged before the integration check ran. The check later failed on a missing postcode field. Rework cost 20 minutes.
```

Only a `markdown-log` source pointing to this file was configured. The run used a task-private `LFM_HOME` and a separate fixture directory. It did not read a Firstmate home or agent sessions. No fixes were applied and nothing was posted to an integration. This was the second saved run of the same fixture; the first run's wording hid one line, so the second was used.

## What the screenshots show

- [Wide excerpt](media/retro-demo.webp): section 4 and the first fix in section 5 of the saved report, unchanged; the report's second fix and later sections are not shown.
- [Phone excerpt](media/retro-demo-mobile.webp): the first fix in section 5 of the same report, unchanged, wrapped to a narrower width.

The text was displayed in a simple local browser viewer and captured with chrome-devtools-axi. The viewer adds the `report.txt · excerpt` label, typography and background; it adds no findings, counts, evidence or verdicts. These are screenshots of the CLI's saved output, not of an interactive terminal. The earlier screenshots remain in the [reference](reference.md).

This example proves that this run read the fixture and saved a report. It does not prove that every repeated cause is distinct, that a fix is right for your project, or that the same models will give the same answer.
