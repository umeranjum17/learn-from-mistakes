#!/usr/bin/env node
// The one source of skills/lfm-retro/SKILL.md. `npm run build:skill` writes it;
// `npm run build:skill -- --check` exits 1 when the committed copy differs.
// The skill is thin: init, doctor, retro, read report.txt, then record a change; `<bin> guide` prints the same steps for the installed version.
// One skill per job: lfm-retro starts a retro or an incident, lfm-fixes lists the life of each fix.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = pkg.name, npx = `npx -y ${bin}`;
const description = `Run a retro on what a project's coding agents keep getting wrong - repeated causes with counts, evidence and checked fixes - with the ${bin} CLI. Use when the user asks what keeps going wrong, wants a retro, wants evidence-backed changes to AGENTS.md, CLAUDE.md or skills, or wants to go deep on one failure (an incident), or asks where an agent's tokens go and how to use fewer.`;

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

## One failure: an incident

When the user wants to go deep on one failure, not on what repeats, run \`${npx} incident "<what failed>" --evidence <path> --wait 8m\` instead of the retro. \`<what failed>\` is the user's own words, a file, or a GitHub PR or issue link; repeat \`--evidence\` for each file, screenshot or link the user names. The run reads only those and the project context. Read its \`report.txt\` (the \`next:\` line names it) and tell the user, in order: the timeline, each root cause with its why chain and cost, why no check caught it, how to avoid it now, and each fix with its owner, priority and due date. Then say what section 7 did not check: the agents cannot see a screenshot, so ask the user to describe it in text. Once the user makes a fix, record it with \`${npx} change applied --proposal <run>:<n> --ref <git sha>\`; \`${npx} incident --status\` then runs the check of each shipped fix and lists the fixes still open. A fix stays open until its check passes.

## Tokens: where they go

When the user asks where the tokens go, or how to use fewer, run \`${npx} tokens retro\` (\`--since 14d\` by default, \`--agents claude,pi\`; with no project config add \`--out <dir>\`). It reads the Claude Code and Pi session stores and calls no agent. Read the \`tokens.txt\` its first line names to the user in plain words: the money split first, then the ranked causes.

- Cache reads are usually most of the cost: every turn re-reads the context so far, so the cost follows turns times context size. Never offer shorter answers as the main fix; that moves only the output share.
- Turn each top cause into one proposed change against a named file (the report gives the change and the metric that must move), and let the user decide. After a change, the next \`tokens retro\` shows each number beside the last run's.
- \`${npx} tokens doctor\` names a store it cannot read, with the reason. \`npm i -g ${bin}\`, then \`${bin} tokens guard install\`, adds the poll guard (a global install keeps the hook's path), which blocks the third identical poll in one context with one line saying what to do instead; \`${npx} tokens guard status\` says what it blocked.

## The retro method

Tell the user the report as a blameless retro, in this order, in plain words. Use only what \`report.txt\` says; never add a number or a cause of your own.

1. Numbers (section 2): for each number, this window, last window and the trend (up, down, flat or unknown). Say which direction is worse.
2. Last changes (section 3): did each past fix work? Give the number before and after, the verdict, and the four states apart: proposal checked, fix applied, fix shipped, fix worked. Name the check command, and tell the user about an accepted fix that no change records. A change that did not help (roll back or delete) is a result, not a fault: ask the user to undo it, and keep a change that worked. A \`skill:\` line names the branch where the run wrote these results into the project's learned skill: ask the user to review and merge it.
3. Repeated mistakes (section 4): for each one give its cost, how often it came back, the why chain down to its root cause, and its fix (section 5). A fix must close the root cause, not hide the symptom.
4. Blameless: name the process, rule, tool or check that had the gap, never a person or an agent. The tool refuses a finding that blames, or that has no why chain or no cost; say when the report shows "No finding gave" a cost or root cause.
5. Fixes (section 5): for each fix, the project rule it replaces or extends and the owner who makes the change. Say which project files the run read before it proposed them, and which it did not read. A fix that names no current project rule was left out; say so.

The user chooses the tool's agents and models; never choose one (full contract: the learn-from-mistakes README section \`Runners and user-chosen models\`). When a command stops with "ask the user which agent to use", ask the user which agent and model to use for each role, then run the init command it printed with their answer, then run the stopped command again. The worker and the judge always run: there is no mode without them, and a run whose agent fails keeps no verdict. The judge may use the worker's agent and model if the user sets it so. Never answer in their place; fix the agent the error names, then run the command again.

\`${npx} guide\` prints these steps for the installed version, and \`${npx} --help\` lists the commands.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lfm-retro\` explicitly: run the steps above, then answer that request from the retro's report.
If it is empty, run the steps above in the project you are in.
`;

const fixesDescription = `List the life of each fix a ${bin} retro or incident proposed - proposed, kept, applied, shipped, worked or reverted - with the ${bin} CLI. Use when the user asks which fixes are still open, whether a past fix shipped or worked, or what happened to a fix.`;
const fixes = `---
name: lfm-fixes
description: ${JSON.stringify(fixesDescription)}
license: ${pkg.license}
metadata:
  version: ${pkg.version}
  argument-hint: <which fix, or empty for all>
  hermes-tags: retrospective, fixes, agents, instructions
  hermes-category: productivity
---

# The life of a fix

A fix to the agents' instructions has one state at a time: \`proposed\` (a retro or an incident kept it), \`kept\` (the user answered apply), \`applied\` (a change records it), \`shipped\` (live on the default branch), \`worked\` (its check passed or its tripwire was met) or \`reverted\` (the default branch reverted it). You list them and read the list to the user. Never change a state yourself, and never run a fix's check: \`fixes\` reads, it runs nothing.

You do not need it installed: run \`${npx} <command>\`.

1. Run \`${npx} fixes\` (\`--json\` for JSON). Each row is \`<run>:<n>\` (or a change id for a change recorded by hand), its cause and its state.
2. Tell the user, in plain words, each fix that is not \`worked\` or \`reverted\`, and what moves it on: \`proposed\` and \`kept\` wait for the user to make the change and record it with \`${npx} change applied --proposal <run>:<n> --ref <git sha>\`; \`applied\` waits for the branch to reach the default branch; \`shipped\` waits for its check (\`${npx} incident --status\` runs an incident fix's check) or the next retro.
3. A \`reverted\` fix is a result, not a fault: say what was reverted and ask the user whether to propose another.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/lfm-fixes\` explicitly: run the steps above, then answer that request from the list.
If it is empty, run the steps above in the project you are in.
`;

// name -> text; `npm run build:skill` writes each, `-- --check` exits 1 when a committed copy differs.
const SKILLS = { 'lfm-retro': skill, 'lfm-fixes': fixes };
let stale = false;
for (const [name, text] of Object.entries(SKILLS)) {
  const file = new URL(`../skills/${name}/SKILL.md`, import.meta.url);
  if (!process.argv.includes('--check')) { mkdirSync(new URL('.', file), { recursive: true }); writeFileSync(file, text); }
  else if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    console.error(`skills/${name}/SKILL.md is stale\nnext: npm run build:skill   # regenerate it from scripts/build-skill.mjs`);
    stale = true;
  }
}
if (stale) process.exit(1);
