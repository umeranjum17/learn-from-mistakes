---
name: lfm-retro
description: "Run a retro on what a project's coding agents keep getting wrong - repeated causes with counts, evidence and checked fixes - with the learn-from-mistakes-axi CLI. Use when the user asks what keeps going wrong, wants a retro, wants evidence-backed changes to AGENTS.md, CLAUDE.md or skills, or wants to go deep on one failure (an incident)."
license: MIT
metadata:
  version: 0.5.0
  argument-hint: <what keeps going wrong, or the log to read>
  hermes-tags: retrospective, defects, agents, instructions
  hermes-category: productivity
---

# Learn from mistakes

learn-from-mistakes-axi runs a retro: it reads a project's records of past work, its own agents label and judge them, and it counts the causes that repeat. You start it and read the result to the user. Never judge a record yourself, and never edit the sources or instruction files: a change is the user's call.

You do not need it installed: run `npx -y learn-from-mistakes-axi <command>`. If its output shows a command starting with `learn-from-mistakes-axi`, run it as `npx -y learn-from-mistakes-axi ...` instead.

1. No `.learn-from-mistakes.yaml` in the project? Run `npx -y learn-from-mistakes-axi init`.
2. Run `npx -y learn-from-mistakes-axi doctor`. Fix each `fail` line with the `fix:` line under it, then run doctor again.
3. Run `npx -y learn-from-mistakes-axi retro --wait 8m`. While the run is still running, run `npx -y learn-from-mistakes-axi attach` (or `status`) until it ends.
4. Read the run's `report.txt` (`npx -y learn-from-mistakes-axi report` prints its path as `report_txt`) and tell the user what it says in plain words.
5. If sign-off is installed and signoff is not off, use sign-off's skill on the run's decisions (the whole report goes there only with signoff_report: on, or `signoff report`); else ask the user the questions in section 7 of `report.txt`.
6. Once the user has made a change, record it with `npx -y learn-from-mistakes-axi change applied --proposal <run>:<n> --ref <git sha>`; it records the fix's check command (`--check` sets another), and the next retro checks whether it worked.

## One failure: an incident

When the user wants to go deep on one failure, not on what repeats, run `npx -y learn-from-mistakes-axi incident "<what failed>" --evidence <path> --wait 8m` instead of the retro. `<what failed>` is the user's own words, a file, or a GitHub PR or issue link; repeat `--evidence` for each file, screenshot or link the user names. The run reads only those and the project context. Read its `report.txt` (the `next:` line names it) and tell the user, in order: the timeline, each root cause with its why chain and cost, why no check caught it, how to avoid it now, and each fix with its owner, priority and due date. Then say what section 7 did not check: the agents cannot see a screenshot, so ask the user to describe it in text. Once the user makes a fix, record it with `npx -y learn-from-mistakes-axi change applied --proposal <run>:<n> --ref <git sha>`; `npx -y learn-from-mistakes-axi incident --status` then runs the check of each shipped fix and lists the fixes still open. A fix stays open until its check passes.

## The retro method

Tell the user the report as a blameless retro, in this order, in plain words. Use only what `report.txt` says; never add a number or a cause of your own.

1. Numbers (section 2): for each number, this window, last window and the trend (up, down, flat or unknown). Say which direction is worse.
2. Last changes (section 3): did each past fix work? Give the number before and after, the verdict, and the four states apart: proposal checked, fix applied, fix shipped, fix worked. Name the check command, and tell the user about an accepted fix that no change records. A change that did not help (roll back or delete) is a result, not a fault: ask the user to undo it, and keep a change that worked. A `skill:` line names the branch where the run wrote these results into the project's learned skill: ask the user to review and merge it.
3. Repeated mistakes (section 4): for each one give its cost, how often it came back, the why chain down to its root cause, and its fix (section 5). A fix must close the root cause, not hide the symptom.
4. Blameless: name the process, rule, tool or check that had the gap, never a person or an agent. The tool refuses a finding that blames, or that has no why chain or no cost; say when the report shows "No finding gave" a cost or root cause.
5. Fixes (section 5): for each fix, the project rule it replaces or extends and the owner who makes the change. Say which project files the run read before it proposed them, and which it did not read. A fix that names no current project rule was left out; say so.

The user chooses the tool's agents and models; never choose one (full contract: the learn-from-mistakes README section `Runners and user-chosen models`). When a command stops with "ask the user which agent to use", ask the user which agent and model to use for each role, then run the init command it printed with their answer, then run the stopped command again. The worker and the judge always run: there is no mode without them, and a run whose agent fails keeps no verdict. The judge may use the worker's agent and model if the user sets it so. Never answer in their place; fix the agent the error names, then run the command again.

`npx -y learn-from-mistakes-axi guide` prints these steps for the installed version, and `npx -y learn-from-mistakes-axi --help` lists the commands.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lfm-retro` explicitly: run the steps above, then answer that request from the retro's report.
If it is empty, run the steps above in the project you are in.
