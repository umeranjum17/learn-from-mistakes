---
name: learn-from-mistakes
description: "Find what a project's coding agents keep getting wrong - repeated causes with counts and evidence from a defect log or failed pipeline runs - using the learn-from-mistakes-axi CLI. Use when the user asks what keeps going wrong, wants a retro with counts from a defect log, failed runs or this repo agent sessions, wants evidence-backed changes to AGENTS.md/CLAUDE.md/skills, or records that an instruction change was applied."
license: MIT
metadata:
  author: Umer Anjum (umeranjum17)
  version: 0.1.0
  argument-hint: <what keeps going wrong, or the log to read>
  hermes-tags: retrospective, defects, agents, instructions
  hermes-category: productivity
---

# Learn from mistakes

learn-from-mistakes-axi counts the causes a project's coding agents keep repeating. You read each record of past work (a markdown defect log, failed no-mistakes pipeline steps, and this repo's Claude Code, Codex and OpenCode sessions) and judge what went wrong; the CLI merges duplicates, counts each cause per source, flags the repeated ones and checks that every recommended change cites real records.

You start a retro (`npx -y learn-from-mistakes-axi retro --wait 15m`); the tool runs its own agent, the worker set in its config (such as Go Muse through BYOKit), to label the records; the run never picks one. You only start it and read the result. With no worker set, the retro stops and names the key to set.

## Current guidance lives in the CLI

Do not follow a procedure from this file - installed copies go stale. Get the current one from the CLI:

- `npx -y learn-from-mistakes-axi --help` for commands and options
- `npx -y learn-from-mistakes-axi guide` for the procedure: config, ingest, label, propose, report

You do not need learn-from-mistakes-axi installed - invoke it with `npx -y learn-from-mistakes-axi <command>`.
If its output shows a follow-up command starting with `learn-from-mistakes-axi`, run it as `npx -y learn-from-mistakes-axi ...` instead.
Never edit the sources or instruction files; your output is a report and recommendations only.

## Model

Do this work on the cheap default model of the agent CLI that runs it; `npx -y learn-from-mistakes-axi agents` lists each one.
Never take Opus, Sonnet or Sol as the default.
The tool's own agent is `agent:` in ~/.learn-from-mistakes/config.yaml (default auto), with its model in `agent_config.<agent>.model`; a project's .learn-from-mistakes.yaml may override both.
The CLI makes no network or model calls itself; only its runs, `npx -y learn-from-mistakes-axi agents --test` and `npx -y learn-from-mistakes-axi doctor --live` start your own agent CLI or a BYOKit route.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/learn-from-mistakes` explicitly - fetch the current CLI guidance, then answer that request with a repeated-cause report.
If it is empty, find the project's records from the conversation and the working directory, then do the same.
