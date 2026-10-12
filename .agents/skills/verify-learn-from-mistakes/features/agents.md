# Agent runners (`agents`, `agents --test <runner>`)

## Sub-features
`src/runners/index.mjs` holds the runner table (claude, codex, opencode, in auto
order) and `src/models.json` the cheap default models per runner (data, no id in
code). A runner is usable when its binary (global `runner_path`, else PATH) runs
`--version` with exit 0; a broken shim is not usable and shows the cause.
`agents` prints each runner: usable, version, tools (`off`, or `read-only` for
Codex), login presence (file and variable names only, never contents), the
default model (the first table model for that runner, or the configured model
where the runner's table lists it or the role pins that runner) and the real binary path. With a project config it adds the
resolved `worker` and `judge` by the identity rule (real binary path + model; an
empty model on the same binary is equal); a judge clash exits 1 with `problem:`
and the fix. `agents --test <runner>` makes one live call in
`<state dir>/runs/test-<runner>/`: the prompt starts with `lfm-run:test:<runner>`
and asks the agent to write `x.txt`; any new file in the run dir, no answer by
`caps.timeout`, no JSON in the answer or the agent's own error exits 1 with the
real cause. Transient errors (429/503/529, overloaded, rate_limit, ECONNRESET)
retry twice; quota text never retries. The agent process group is killed at the
timeout (SIGTERM, SIGKILL after 3 s); after exit a grandchild holding stdout gets
5 s before the pipes close.

Argv (confirmed live on claude 2.1.296 and opencode 1.18.25; codex from `--help`):
- claude: `-p --output-format json [--model M] --tools "" --no-session-persistence --strict-mcp-config`, prompt on stdin. Not `--bare`: it never reads an OAuth login ("Not logged in").
- codex: `exec [-m M] -s read-only --ephemeral --skip-git-repo-check -o <run>/out-<step>.txt -`, prompt on stdin.
- opencode: `run [-m M] --format json --dir <run> -f <run>/prompt-<step>.md -- "<marker> Follow the instructions in the attached file."` with `OPENCODE_PERMISSION={"*":"deny"}` (it then has no tools: "Available tools: .").

## How to get to it (user POV)
`learn-from-mistakes-axi agents` anywhere; `learn-from-mistakes-axi agents --test <runner>`
in a project with `.learn-from-mistakes.yaml`.

## Driving it with the public CLI
`test/runners.test.mjs` owns the journeys with fake `claude`, `codex` and
`opencode` binaries (PATH holds only them): the listing (versions, login file
name without its canary contents, models from `src/models.json`, a broken shim,
`LFM_MODEL`), the judge clash (exit 1 and fix), each runner's exact argv, cwd,
marker and `OPENCODE_PERMISSION`, a global `runner_args` entry, and a hung (killed
at `caps.timeout: 2s`), leaking (grandchild holds stdout), writing (`x.txt`,
exit 1) and overloaded-once (retried) agent. The helper drives `agents --json`
on the host PATH in its scratch HOME to capture evidence (no live call).

Real-product proof (outside the repo; small cost; `$SCR` scratch, `$SELF` this checkout,
`$LAB` a lab HOME holding only a link to the lab Claude credential):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
labenv lfm agents
labenv <credential lock> lfm agents --test claude   # one Claude run at a time on the lab credential
labenv lfm agents --test codex
lfm agents --test opencode                          # the desktop's own OpenCode login, read only
ls -A .lfm/runs/test-*; git status --short
```

Each `--test` prints `reply`, or the real
error. `ls` shows no `x.txt` (only `prompt-<runner>.md`, and Codex's
`out-codex.txt`); `git status --short` shows only the 3 copied files.

## Gotchas
A mise shim on PATH resolves to mise itself, so two shimmed runners count as the
same binary (the identity rule then refuses, the safe side). A launcher script
that finds its runtime under `$HOME` fails `--version` under a lab HOME and is
"not usable" there. OpenCode keeps its session; later retros skip it by the
`lfm-run:` marker and the `.lfm/` run dir. Codex can still read files (R3).
