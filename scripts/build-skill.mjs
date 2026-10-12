#!/usr/bin/env node
// The one source of skills/learn-from-mistakes/SKILL.md. `npm run build:skill` writes it;
// `npm run build:skill -- --check` exits 1 when the committed copy differs.
// The skill is a stub: the procedure lives in `<bin> guide`, so an installed copy never goes stale.
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url);
const bin = pkg.name, npx = `npx -y ${bin}`;
const description = `Find what a project's coding agents keep getting wrong - repeated causes with counts and evidence from a defect log or failed pipeline runs - using the ${bin} CLI. Use when the user asks what keeps going wrong, wants a retro with counts from a defect log or failed runs, wants evidence-backed changes to AGENTS.md/CLAUDE.md/skills, or records that an instruction change was applied.`;

const skill = `---
name: learn-from-mistakes
description: ${JSON.stringify(description)}
license: ${pkg.license}
metadata:
  author: Umer Anjum (umeranjum17)
  version: ${pkg.version}
  argument-hint: <what keeps going wrong, or the log to read>
  hermes-tags: retrospective, defects, agents, instructions
  hermes-category: productivity
---

# Learn from mistakes

${bin} counts the causes a project's coding agents keep repeating. You read each record of past work (a markdown defect log, failed no-mistakes pipeline steps) and judge what went wrong; the CLI merges duplicates, counts each cause per source, flags the repeated ones and checks that every recommended change cites real records.

## Current guidance lives in the CLI

Do not follow a procedure from this file - installed copies go stale. Get the current one from the CLI:

- \`${npx} --help\` for commands and options
- \`${npx} guide\` for the procedure: config, ingest, label, propose, report

You do not need ${bin} installed - invoke it with \`${npx} <command>\`.
If its output shows a follow-up command starting with \`${bin}\`, run it as \`${npx} ...\` instead.
Never edit the sources or instruction files; your output is a report and recommendations only.

## Model

Do this work on the cheap default model of the agent CLI that runs it; \`${npx} agents\` lists each one.
Never take Opus, Sonnet or Sol as the default.
To use your own model instead, set LFM_MODEL (or worker.model) to its id. With worker.runner auto it must be a model an agent CLI lists as its default, else set worker.runner to the CLI that runs it (\`${npx} guide\` then names it).
The CLI makes no network or model calls itself; only \`${npx} agents --test\` starts your own agent CLI.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/learn-from-mistakes\` explicitly - fetch the current CLI guidance, then answer that request with a repeated-cause report.
If it is empty, find the project's records from the conversation and the working directory, then do the same.
`;

if (!process.argv.includes('--check')) writeFileSync(file, skill);
else if (readFileSync(file, 'utf8') !== skill) {
  console.error('skills/learn-from-mistakes/SKILL.md is stale\nnext: npm run build:skill   # regenerate it from scripts/build-skill.mjs');
  process.exit(1);
}
