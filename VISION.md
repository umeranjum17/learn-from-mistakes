# Vision

This file records what learn-from-mistakes is for and how it fits with its two sibling tools.

## The three-tool family

Three tools work as one family. Each tool has one main job.

- **sign-off** is the main communication board between agents, projects and the user.
  It gives projects a written contract for how they communicate.
- **done-done** is the main verification tool.
  It proves that work is really done.
- **learn-from-mistakes** is the main retro tool.
  It finds the mistakes that repeat and checks whether each fix helped.

## Self-sufficient, and better together

- Each tool works alone. The skill and the CLI need no other tool.
- Each tool works with or without the other two.
- Each tool works with or without an agent supervisor.
- Together, the tools connect through small written contracts.
  One tool reads what another writes. No tool reaches into another tool's state.

## Primitives, not forks

- Each tool owns project-agnostic primitives: small building blocks that any project can use.
- A project that needs custom behaviour gets a new primitive in the tool.
  It does not fork the tool or keep a private copy.

## One migration, then a base for new projects

- An existing project migrates once, from its local pieces to the tool's primitives.
- After the migration, the project keeps no old copy of those pieces.
- A new project starts from the tool's base. It has nothing to migrate.

## The user sets everything

- The user sets every option. The tool picks no agent, model or account for the user.
- Nothing runs automatically. The user starts each run.
- The user brings their own agents, models and accounts.
- The tools have zero hosted cost. Nothing runs on a server that we pay for.

## Design bar

- Every surface gets the best human-computer interaction we can give it.
- This includes the CLI output, the help text, the errors, the skill and the docs.
- An error names the real cause and the next step to fix it.

## Patterns

The tools follow the patterns of Kun Chen's tools:

- an AXI CLI that any capable agent can run without setup;
- TOON output by default, with `--json` when asked;
- a `next:` help line that names the likely next command;
- a skill that installs with one command;
- distribution through npm.

## learn-from-mistakes in detail

learn-from-mistakes reads what your agents left behind and finds the causes that repeat.
Your agent judges each record. The CLI does the arithmetic and checks the evidence.

What it does today:

- **Sources.** It reads, read-only: a markdown defect log, the failed steps in a no-mistakes store,
  the agent sessions run in the repo (Claude Code, Codex, OpenCode, and Pi and Gemini CLI when named in `agents`), a Firstmate home when you opt in (`init --firstmate <home>`) and the merged pull requests on GitHub.
- **Findings.** It counts each cause per source, merges duplicates and lists records nobody labelled.
  It never guesses a label.
- **Proposed rule changes with evidence.** Your agent proposes changes by following `guide`.
  The CLI checks that each proposal cites real records.
- **A versioned ledger.** `change applied` records a change you already made, and `apply` records a kept fix committed to its own branch, as one append-only entry (`chg-<n>`).
  `changes --json` prints the ledger as a stable contract (`lfm-changes.v1`).
- **Did the last fix help.** The `followup` step compares each change's metric before and after the change.
  Code, not a model, gives the verdict: `keep`, `fix`, `rollback`, `delete` or `no-data`.
- **Saved runs.** `retro` collects, measures, follows up, writes a bundle, labels with the agent you set, and reports, as one saved run.
  You can watch, abort or resume it.
- **Doctor.** `doctor` names each problem and its fix.

What it does not do:

- It never edits your sources or instructions in your working tree. An accepted fix goes only to its own branch, `lfm/<run>-<n>`, from HEAD, and is recorded in the ledger. The one file it writes outside .lfm/ is its own skill, when you run init. It never pushes, merges, or touches your branch or uncommitted work.
- It makes no model call itself. Only your own agent CLI, started by a run or by `apply`, calls a model.

Planned:

- sign-off shows a "Helped?" answer for each applied change, joined on the change id.

## Works with

- [sign-off](https://github.com/umeranjum17/sign-off): the family's communication board. sign-off owns one strict, versioned [communication contract](https://github.com/umeranjum17/sign-off/blob/main/docs/contract.md) for messages between the tools. The explicit `signoff post` hand-off sends learn-from-mistakes' kept fixes as the contract's `finding` kind, with Apply or Skip options, and `signoff answers` reads the answers back. A message the board refuses is fixed at the producer, never stored or shown half-valid. learn-from-mistakes still works alone without sign-off.
- [done-done](https://github.com/umeranjum17/done-done-axi): the family's verification tool.
- [Firstmate](https://github.com/kunchenguid/firstmate): an agent supervisor; the tool reads its records (see the README).
- [no-mistakes](https://github.com/kunchenguid/no-mistakes): its failed pipeline steps are a source.
- [quota-axi](https://github.com/kunchenguid/quota-axi): an AXI tool for agent quota; a pattern this tool follows.

Each of these is optional. learn-from-mistakes works without any of them.
