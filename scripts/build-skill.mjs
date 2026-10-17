#!/usr/bin/env node
// The one source of skills/learn-from-mistakes/SKILL.md. `npm run build:skill` writes it;
// `npm run build:skill -- --check` exits 1 when the committed copy differs.
// The skill is thin: init, doctor, retro, then read report.txt; `<bin> guide` prints the same steps for the installed version.
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../skills/learn-from-mistakes/SKILL.md', import.meta.url);
const bin = pkg.name, npx = `npx -y ${bin}`;
const description = `Run a retro on what a project's coding agents keep getting wrong - repeated causes with counts, evidence and checked fixes - with the ${bin} CLI. Use when the user asks what keeps going wrong, wants a retro, or wants evidence-backed changes to AGENTS.md, CLAUDE.md or skills.`;

const skill = `---
name: learn-from-mistakes
description: ${JSON.stringify(description)}
license: ${pkg.license}
metadata:
  version: ${pkg.version}
  argument-hint: <what keeps going wrong, or the log to read>
  hermes-tags: retrospective, defects, agents, instructions
  hermes-category: productivity
---

# Learn from mistakes

${bin} runs a retro: it reads a project's records of past work, its own agents label and judge them, and it counts the causes that repeat. You start it and read the result to the user. Never judge a record yourself, and never edit the sources or instruction files: a change is the user's call.

You do not need it installed: run \`${npx} <command>\`. If its output shows a command starting with \`${bin}\`, run it as \`${npx} ...\` instead.

1. No \`.learn-from-mistakes.yaml\` in the project? Run \`${npx} init\`.
2. Run \`${npx} doctor\`. Fix each \`fail\` line with the \`fix:\` line under it, then run doctor again.
3. Run \`${npx} retro --wait 8m\`. While the run is still running, run \`${npx} attach\` (or \`status\`) until it ends.
4. Read the run's \`report.txt\` (\`${npx} report\` prints its path as \`report_txt\`) and tell the user what it says in plain words.
5. If sign-off is installed and signoff is not off, use sign-off's skill on the run's decisions; else ask the user the questions in section 7 of \`report.txt\`.

The user chooses the tool's agents and models; never choose one (full contract: the learn-from-mistakes README section \`Runners and user-chosen models\`). When a command stops with "ask the user which agent to use", ask the user which agent and model to use for each role, then run the init command it printed with their answer, then run the stopped command again.

\`${npx} guide\` prints these steps for the installed version, and \`${npx} --help\` lists the commands.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/learn-from-mistakes\` explicitly: run the steps above, then answer that request from the retro's report.
If it is empty, run the steps above in the project you are in.
`;

if (!process.argv.includes('--check')) writeFileSync(file, skill);
else if (readFileSync(file, 'utf8') !== skill) {
  console.error('skills/learn-from-mistakes/SKILL.md is stale\nnext: npm run build:skill   # regenerate it from scripts/build-skill.mjs');
  process.exit(1);
}
