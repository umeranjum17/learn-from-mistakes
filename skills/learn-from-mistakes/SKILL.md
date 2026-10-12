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

learn-from-mistakes-axi counts the causes a project's coding agents keep repeating. You read each record of past work (a markdown defect log, failed no-mistakes pipeline steps, and this repo's Claude Code sessions) and judge what went wrong; the CLI merges duplicates, counts each cause per source, flags the repeated ones and checks that every recommended change cites real records.

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
To use your own model instead, set LFM_MODEL (or worker.model) to its id. With worker.runner auto it must be a model an agent CLI lists as its default, else set worker.runner to the CLI that runs it (`npx -y learn-from-mistakes-axi guide` then names it).
The CLI makes no network or model calls itself; only `npx -y learn-from-mistakes-axi agents --test` starts your own agent CLI.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/learn-from-mistakes` explicitly - fetch the current CLI guidance, then answer that request with a repeated-cause report.
If it is empty, find the project's records from the conversation and the working directory, then do the same.
