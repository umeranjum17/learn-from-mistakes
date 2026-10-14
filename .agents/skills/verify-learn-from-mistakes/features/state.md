# Project state dir (`.lfm/`)

## Sub-features
Default state dir `<project>/.lfm` (the dir holding `.learn-from-mistakes.yaml`);
`learn-from-mistakes-axi` writes `.lfm/.gitignore` containing `*` whenever it writes state there and
none exists, and never overwrites one; an existing one must contain the line `*`
with no line starting with `!`, or `retro` and `change applied` exit 2 before
any state is written. The project's own `.gitignore` is never
touched. A global `state_root` in `$LFM_HOME/config.yaml` still wins and keeps
`<state_root>/<name>` (no `.gitignore` there). Same-named projects in different
parents keep separate state.

## How to get to it (user POV)
In a project with `.learn-from-mistakes.yaml`: `learn-from-mistakes-axi retro` writes its run
to `<project>/.lfm`; `git status` stays clean of it.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journeys
`state lives in the project's own .lfm/, git-ignored by the tool, never in a commit`
(git-initialised copy: `change applied` then `retro`/`report` create `.lfm/` with
`*`, records hold their text (excerpts on), `git status --porcelain --untracked-files=all` has no
`.lfm` line and `--ignored` shows `!! .lfm/`; a deficient owner `.gitignore`
(`*.jsonl`) and a negated one (`*` plus `!records.jsonl`) each exit 2 on retro
and change applied with the file byte-identical and no state written, while `*`
alone or with comments is accepted byte-identical; a `.gitignore` directory or a
stray `.lfm` file exits 2 naming the path, with a `next:` fix, before any state is written) and
`same-named projects keep separate state; a global state_root still wins`.
`--package` reruns both through the installed bin (`packed-npm-test`). The
helper keeps a copy of the staged `.lfm/` as `state/` in the evidence folder.

## Gotchas
The `.gitignore` is written on any state write when missing, so deleting it does
not un-ignore the state; edit it instead. No migration of old
`~/.learn-from-mistakes/state/<name>` dirs. Reads (`report`, `changes`) never
create `.lfm/`.
