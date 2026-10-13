#!/usr/bin/env node
// The one source of skills/learn-from-mistakes/SKILL.md. `npm run build:skill` writes it;
// `npm run build:skill -- --check` exits 1 when the committed copy differs.
// The skill is a stub: the procedure lives in `<bin> guide`, so an installed copy never goes stale.
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url);
const bin = pkg.name, npx = `npx -y ${bin}`;
const description = `Find what a project's coding agents keep getting wrong - repeated causes with counts and evidence from a defect log or failed pipeline runs - using the ${bin} CLI. Use when the user asks what keeps going wrong, wants a retro with counts from a defect log, failed runs or this repo agent sessions, wants evidence-backed changes to AGENTS.md/CLAUDE.md/skills, or records that an instruction change was applied.`;

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

${bin} counts the causes a project's coding agents keep repeating. You read each record of past work (a markdown defect log, failed no-mistakes pipeline steps, and this repo's Claude Code, Codex and OpenCode sessions) and judge what went wrong; the CLI merges duplicates, counts each cause per source, flags the repeated ones and checks that every recommended change cites real records.

You start a retro (\`${npx} retro --wait 15m\`); the tool runs its own agent, the \`agent\` set in its config, to label the records; the run never picks one. You only start it and read the result. With the agent or its model not set, the retro stops with "ask the user which agent to use": ask the user which agent and model to use for each role, never choose, then run the init command it prints with the answer, then run the stopped command again.

## Current guidance lives in the CLI

Do not follow a procedure from this file - installed copies go stale. Get the current one from the CLI:

- \`${npx} --help\` for commands and options
- \`${npx} guide\` for the procedure: config, ingest, label, propose, report

You do not need ${bin} installed - invoke it with \`${npx} <command>\`.
If its output shows a follow-up command starting with \`${bin}\`, run it as \`${npx} ...\` instead.
Never edit the sources or instruction files; your output is a report and recommendations only.

## Model

The user chooses the models; never choose one yourself, and never switch to Opus, Sonnet or Sol.
The tool's own agents are \`agent:\` and \`judge_agent:\` in ~/.learn-from-mistakes/config.yaml, each with its model in \`agent_config.<agent>.model\`; a project's .learn-from-mistakes.yaml may override them. The user sets them: the tool never picks one, and neither do you.
When a command prints "ask the user which agent to use", ask the user which agent and model to use for each role named, never choose one yourself, then run the \`${npx} init ...\` command it printed with the user's answer, then run the stopped command again.
The CLI makes no network or model calls itself; only its runs, \`${npx} agents --test\` and \`${npx} doctor --live\` start your own agent CLI or a BYOKit route.

## Optional finding handoff

Only when the user asks, run \`${npx} signoff post [--run <id>]\` (latest completed run by default).
Without the optional peer it prints findings and \`npm i -g sign-off-axi\`; retro never posts automatically.
\`${npx} signoff answers\` runs \`sign-off-axi wait --filer learn-from-mistakes --timeout 1 --json\`: it takes each answer to posted findings once and stores Apply/Skip against proposals (a later answer replaces the stored one), never applies a change; with no new answers it says so and exits 0, and any other value is skipped with a warning naming the key.
The adapter sends each kept fix to \`sign-off-axi post --kind finding --from -\` (the binary on PATH; \`npm i -g sign-off-axi\` installs it), one contract-v1 message per kept fix:

\`\`\`json
{"contract":1,"kind":"finding","schema":1,"key":"lfm-3-1-7f3a91c2","title":"Repeated cause: missing env var in CI","filer":"learn-from-mistakes","about":"4 incidents over 3 days in 2 sources.","cause":"missing-env","incidents":4,"days":3,"evidence_ids":["rec-7f3a","rec-91be"],"change_kind":"doc","proposal":"Add the env var to the CI setup page.","options":[{"value":"apply","label":"Apply"},{"value":"skip","label":"Skip"}],"recommend_value":"apply"}
\`\`\`

To wait explicitly: \`sign-off-axi wait --filer learn-from-mistakes --events\` prints:

\`\`\`json
{"event":"answer","contract":1,"kind":"finding","schema":1,"key":"lfm-3-1-7f3a91c2","title":"Repeated cause: missing env var in CI","answer":"apply","label":"Apply","close":"done","at":"2026-10-13T08:00:00Z","filer":"learn-from-mistakes"}
\`\`\`

A refused message is not saved: exit 2, VALIDATION_ERROR and a help line naming the fix.
Posting again sends the same message, so rerun retro to produce a valid finding first; never edit the board file by hand.
Check \`sign-off-axi --help\` for installed support (the contract lands in parts), never guess flags.
Record text stays out: about has counts only, evidence_ids names records, and proposal is the change, not a quote.

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
