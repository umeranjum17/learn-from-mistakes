---
name: lfm-fixes
description: "List the life of each fix a learn-from-mistakes-axi retro or incident proposed - proposed, kept, applied, shipped, worked or reverted - with the learn-from-mistakes-axi CLI. Use when the user asks which fixes are still open, whether a past fix shipped or worked, or what happened to a fix."
license: MIT
metadata:
  version: 0.12.0
  argument-hint: <which fix, or empty for all>
  hermes-tags: retrospective, fixes, agents, instructions
  hermes-category: productivity
---

# The life of a fix

A fix to the agents' instructions has one state at a time: `proposed` (a retro or an incident kept it), `kept` (the user answered apply), `applied` (a change records it), `shipped` (live on the default branch), `worked` (its check passed or its tripwire was met) or `reverted` (the default branch reverted it). You list them and read the list to the user. Never change a state yourself, and never run a fix's check: `fixes` reads, it runs nothing.

You do not need it installed: run `npx -y learn-from-mistakes-axi <command>`.

1. Run `npx -y learn-from-mistakes-axi fixes` (`--json` for JSON). Each row is `<run>:<n>` (or a change id for a change recorded by hand), its cause and its state.
2. Tell the user, in plain words, each fix that is not `worked` or `reverted`, and what moves it on: `proposed` and `kept` wait for the user to make the change and record it with `npx -y learn-from-mistakes-axi change applied --proposal <run>:<n> --ref <git sha>`; `applied` waits for the branch to reach the default branch; `shipped` waits for its check (`npx -y learn-from-mistakes-axi incident --status` runs an incident fix's check) or the next retro.
3. A `reverted` fix is a result, not a fault: say what was reverted and ask the user whether to propose another.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lfm-fixes` explicitly: run the steps above, then answer that request from the list.
If it is empty, run the steps above in the project you are in.
