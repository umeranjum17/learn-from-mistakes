# Project context: what the project already says

A record explains an incident, but not the rule the project already has, and not who owns it.
So a fix can repeat a rule that exists, or change one without naming it.
Before the worker proposes fixes, the retro reads a bounded set of the project's own files: the docs the config lists
(`README.md`, `AGENTS.md`, `CLAUDE.md` by default), each `SKILL.md` under the project's skill folders
(`.agents/skills` and `skills` by default), and the code the incident records point at.

The bounds are fixed and in the config: `context: { max_files: 12, max_chars: 2000, docs: [...], skills: [...] }`,
with `context: off` to keep every project file local.
Only files inside the project folder are read, never a secret file (a `.env`, a key, a credential file), and a path in
a record that points out of the project is never followed.
A file over the character cap, a file after the file cap and a secret file are not read; each is named with the reason.

The worker gets the context with the bundle, and a fix of kind `rule` names the project rule it replaces or extends
(`current_rule`, in plain words) and the file that rule is in (`rule_ref`, a file the run read).
A fix that names no current rule is left out, and the report says so.
`report.txt` names the files the run read in section 5, the current rule under each fix with a pointer to the line that
holds it, and the files it did not read, with the reason, in section 6.

## Driving it

The `retro-context` drive in `scripts/verify-journeys.mjs` runs a retro over a made-up project with a rule in
`AGENTS.md`, a README, a project skill, a file over the cap and a secret file.
It checks the run's `context.md` (what was read, what was not, and the reason) and `report.txt` (the files it read,
the context it skipped, and the fix that names the current rule).
