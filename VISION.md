# Vision

learn-from-mistakes is the open-source retro tool. Its sister tools are done-done and sign-off.

## Who it is for

Developers tired of fixing the same coding-agent mistakes.
It must work alone, for people with no agent supervisor.

## The problem

The same coding-agent mistakes keep coming back, and developers keep fixing them by hand.

## The end state

The tool turns what went wrong into versioned improvements to agent instructions:

1. **Read the record of past work:** defect logs, failed proofs, review findings, steers and corrections, slow or stuck lanes, CI reruns.
2. **Find repeated causes and measure them.**
3. **Propose small, concrete changes** to AGENTS.md, CLAUDE.md, skills and config, each with the evidence behind it.
4. **Keep every change versioned** with what changed, why, and whether it helped afterwards (before/after numbers), and roll back changes that did not help.

It is a CLI plus agent skills, with per-project and global config.

## The three-tool family

- **sign-off** is the communication board between agents, projects and the user.
- **done-done** is the verification tool. It proves that work is really done.
- **learn-from-mistakes** is the retro tool. It finds the mistakes that repeat and checks whether each fix helped.

Each tool works alone, with or without the other two, and with or without an agent supervisor.
Together they connect through small written contracts: one tool reads what another writes, and no tool reaches into another tool's state.

## Principles

- **Primitives, not forks.** The tool owns small, project-agnostic building blocks. A project that needs custom behaviour gets a new primitive in the tool, not a fork or a private copy.
- **The user sets everything.** The tool picks no agent, model or account. Nothing runs automatically; the user starts each run with their own agents, models and accounts.
- **Zero hosted cost.** Nothing runs on a server that we pay for.
- **Code, not a model, gives the verdict** on whether a change helped.
- **Public repo.** Never commit secrets, private data, transcripts or private project names.

## Quality bar

- Real tests, real live captures, no shortcuts.
- Every claim cites evidence, and the report names what it did not check.
- Every surface gets the best human-computer interaction we can give it: the CLI output, the help text, the errors, the skill and the docs.
- An error names the real cause and the next step to fix it.

## What it is not

- It does not edit your sources or instructions in your working tree. An accepted fix goes only to its own branch and is recorded in the ledger.
- It does not push, merge, or touch your branch or uncommitted work.
- It makes no model call itself. Only your own agent CLI calls a model.
- It does not need sign-off, done-done or any agent supervisor. Each is optional.

## Milestones

- **0.5.0, shipped 22 Oct 2026:** blameless 5-whys with trends, slowest waits, the `lfm-retro` skill, new sources, an honest "Not checked" list, and fix tracking with check commands.
- **Next: incident mode.** Go deep on one named failure, with dated fixes tracked until their check passes. The code is merged; its docs are being written.
