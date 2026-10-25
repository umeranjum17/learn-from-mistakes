# The demo is a real report

[Back to the quick start](../README.md)

## Current hero: 0.7.0

The README's light and dark hero images show the same unchanged excerpt of `report.txt` from the published **0.7.0** CLI, run on **25 October 2026**. The phone images wrap the same text more narrowly. The viewer adds a frame, type and a `report.txt · excerpt` label; it adds no findings, evidence, counts or verdicts. These are captures of the CLI's saved report, not an interactive terminal or a proposed interface.

Only six synthetic defect records for Umer were configured. No real sessions, task logs or customer records were read. Pi ran both worker and judge with `openai-codex/gpt-6.1-sol`, low effort, tools off, in fresh calls. The run completed, labelled all six records and found one repeated cause across four days. The five synthetic rework amounts sum to **110 minutes**; this is not a measured saving.

One proposed fix passed the report rules. The judge **weakened** it, rather than confirming it. Section 6 says so. No fix was applied. The hero shows section 4 only; it does not imply that the fix was confirmed.

### Reproduce it

Install `learn-from-mistakes-axi@0.7.0` from npm in a separate demo project. Use the six records in [Made-up input](#made-up-input), changing the four date headings to 2026-10-24, 2026-10-23, 2026-10-22 and 2026-10-21 respectively for the captured run. On a later date, move them inside the preceding seven days. Create this `.learn-from-mistakes.yaml`:

```yaml
name: umer-demo
agent: pi
judge_agent: pi
agent_config:
  pi: { model: openai-codex/gpt-6.1-sol, effort: low }
agent_timeout: 4m
window: 7d
signoff: off
excerpts: on
sources:
  log: { type: markdown-log, path: defects.md }
causes:
  test-failed:
    description: A change went on before its integration check passed.
```

The demo project's `README.md` was:

```markdown
# Umer's demo shop

Synthetic shop project used only to demonstrate a retrospective. No customer records.

## Merge checklist

Review the patch and merge it. The integration check is not required by this checklist.
```

With Pi installed and signed in, and an empty task-private `LFM_HOME`:

```sh
learn-from-mistakes-axi retro --wait
learn-from-mistakes-axi report
```

Open the `report_txt` path. A different model or another run may produce different wording or verdicts. This demonstrates one real run, not general accuracy. The current hero's exact excerpt is:

```text
4. Repeated mistakes
- test-failed: 6 times on 4 days.
   Cost: Five changes needed 110 minutes of rework.
   Why 1: Integration checks found defects after changes merged.
   Why 2: Changes merged before the integration checks ran.
   Root cause: The merge checklist did not require the integration check.
   Fix: see fix 1 in section 5.
   Evidence: defects.md:6; defects.md:5; defects.md:10; and 3 more
```

The social preview uses this same real report excerpt. The repository keeps it at [social-preview.png](social-preview.png); GitHub requires a repository-settings upload to use it as the Open Graph image.

## Earlier capture: 0.4.1

The earlier images show excerpts of `report.txt` saved by the `learn-from-mistakes-axi` CLI (package version 0.4.1) run from this repository on 21 October 2026. They are not invented terminal output or a proposed product interface.

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
