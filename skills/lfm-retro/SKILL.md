---
name: lfm-retro
description: "Run a retro on what a project's coding agents keep getting wrong - repeated causes with counts, evidence and checked fixes - with the learn-from-mistakes-axi CLI. Use when the user asks what keeps going wrong, wants a retro, or wants evidence-backed changes to AGENTS.md, CLAUDE.md or skills."
license: MIT
metadata:
  version: 0.4.1
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
5. If sign-off is installed and signoff is not off, use sign-off's skill on the run's decisions; else ask the user the questions in section 7 of `report.txt`.
6. Once the user has made a change, record it with `npx -y learn-from-mistakes-axi change applied --proposal <run>:<n> --ref <git sha>`; the next retro checks whether it worked.

The user chooses the tool's agents and models; never choose one (full contract: the learn-from-mistakes README section `Runners and user-chosen models`). When a command stops with "ask the user which agent to use", ask the user which agent and model to use for each role, then run the init command it printed with their answer, then run the stopped command again. The worker and the judge always run: there is no mode without them, and a run whose agent fails keeps no verdict. The judge may use the worker's agent and model if the user sets it so. Never answer in their place; fix the agent the error names, then run the command again.

`npx -y learn-from-mistakes-axi guide` prints these steps for the installed version, and `npx -y learn-from-mistakes-axi --help` lists the commands.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lfm-retro` explicitly: run the steps above, then answer that request from the retro's report.
If it is empty, run the steps above in the project you are in.
