#!/usr/bin/env node
// The one source of skills/lfm-retro/SKILL.md. `npm run build:skill` writes it;
// `npm run build:skill -- --check` exits 1 when the committed copy differs.
// The skill is thin: init, doctor, retro, read report.txt, then record a change; `<bin> guide` prints the same steps for the installed version.
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const file = new URL('../skills/lfm-retro/SKILL.md', import.meta.url);
const bin = pkg.name, npx = `npx -y ${bin}`;
const description = `Run a retro on what a project's coding agents keep getting wrong - repeated causes with counts, evidence and checked fixes - with the ${bin} CLI. Use when the user asks what keeps going wrong, wants a retro, or wants evidence-backed changes to AGENTS.md, CLAUDE.md or skills.`;

const skill = `---
name: lfm-retro
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
5. If sign-off is installed and signoff is not off, use sign-off's skill on the run's decisions (the whole report goes there only with signoff_report: on, or \`signoff report\`); else ask the user the questions in section 7 of \`report.txt\`.
6. Once the user has made a change, record it with \`${npx} change applied --proposal <run>:<n> --ref <git sha>\`; it records the fix's check command (\`--check\` sets another), and the next retro checks whether it worked.

## The retro method

Tell the user the report as a blameless retro, in this order, in plain words. Use only what \`report.txt\` says; never add a number or a cause of your own.

1. Numbers (section 2): for each number, this window, last window and the trend (up, down, flat or unknown). Say which direction is worse.
2. Last changes (section 3): did each past fix work? Give the number before and after, the verdict, and the four states apart: proposal checked, fix applied, fix shipped, fix worked. Name the check command, and tell the user about an accepted fix that no change records. A change that did not help (roll back or delete) is a result, not a fault: ask the user to undo it, and keep a change that worked. A \`skill:\` line names the branch where the run wrote these results into the project's learned skill: ask the user to review and merge it.
3. Repeated mistakes (section 4): for each one give its cost, how often it came back, the why chain down to its root cause, and its fix (section 5). A fix must close the root cause, not hide the symptom.
4. Blameless: name the process, rule, tool or check that had the gap, never a person or an agent. The tool refuses a finding that blames, or that has no why chain or no cost; say when the report shows "No finding gave" a cost or root cause.

The user chooses the tool's agents and models; never choose one (full contract: the learn-from-mistakes README section \`Runners and user-chosen models\`). When a command stops with "ask the user which agent to use", ask the user which agent and model to use for each role, then run the init command it printed with their answer, then run the stopped command again. The worker and the judge always run: there is no mode without them, and a run whose agent fails keeps no verdict. The judge may use the worker's agent and model if the user sets it so. Never answer in their place; fix the agent the error names, then run the command again.

\`${npx} guide\` prints these steps for the installed version, and \`${npx} --help\` lists the commands.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lfm-retro\` explicitly: run the steps above, then answer that request from the retro's report.
If it is empty, run the steps above in the project you are in.
`;

if (!process.argv.includes('--check')) writeFileSync(file, skill);
else if (readFileSync(file, 'utf8') !== skill) {
  console.error('skills/lfm-retro/SKILL.md is stale\nnext: npm run build:skill   # regenerate it from scripts/build-skill.mjs');
  process.exit(1);
}
