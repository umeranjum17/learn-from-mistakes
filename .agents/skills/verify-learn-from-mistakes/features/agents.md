# Agent runners (`agents`, `agents --test <runner>`)

## Sub-features
`src/runners/index.mjs` holds the runner table (claude, codex, opencode, pi, gemini,
acp, in auto order; acp runs as `acp:<target>` through the `acpx` binary) and `src/models.json` the default models per runner where it lists one (data, no id in
code). A runner is usable when its binary (global `runner_path`, else PATH) runs
`--version` with exit 0; a broken shim is not usable and shows the cause. A usable
runner whose tool-off mode is not confirmed live (gemini, acp) has `problem:
not offered: <why>` and is never resolved as worker or judge (a pinned one gives
`problem: worker: gemini is not offered: ...`); `--test` still runs on it (a pass does not offer it). An acp target is a plain
name (`[a-z0-9][\w.-]*`): it names the run dir, so a path or `..` exits 2.
`agents` prints each runner: usable, version, tools (`off`, `read-only` for
Codex and Gemini, or `unconfirmed` for acp), login presence (file and variable names only, never contents), the
default model (the first table model for that runner, or the runner's own default when its table is empty, or the configured model
where the runner's table lists it or the role pins that runner) and the real binary path. With a project config it adds the
resolved `worker` and `judge` by the identity rule (real binary path + model; an
empty model on the same binary is equal); a judge clash exits 1 with `problem:`
and the fix. `agents --test <runner>` makes one live call in
`<state dir>/runs/test-<runner>/`: the prompt starts with `lfm-run:test:<runner>`
and asks the agent to write `x.txt`; any new file in the run dir, no answer within
`caps.timeout` in an attempt (each attempt has its own; a call makes at most 3 attempts) or the agent's own error exits 1 with the
real cause; a plain-text answer with no JSON passes and prints as `reply` (the file scan is the check). Transient errors (429/503/529, overloaded, rate_limit, ECONNRESET)
retry twice; quota text never retries. The agent process group is killed at the
timeout (SIGTERM, SIGKILL after 3 s); after exit a grandchild holding stdout gets
5 s before the pipes close.

Argv (confirmed live on claude 2.1.296, opencode 1.18.25 and pi 1.0.0; codex, gemini 0.56.0 and acpx 0.19.3 from `--help` and source):
- claude: `-p --output-format json [--model M] --tools "" --no-session-persistence --strict-mcp-config`, prompt on stdin. Not `--bare`: it never reads an OAuth login ("Not logged in").
- codex: `exec [-m M] -s read-only --ephemeral --skip-git-repo-check -o <run>/out-<step>.txt -`, prompt on stdin.
- opencode: `run [-m M] --format json --dir <run> -f <run>/prompt-<step>.md -- "<marker> Follow the instructions in the attached file."` with `OPENCODE_PERMISSION={"*":"deny"}` (it then has no tools: "Available tools: .").
- pi: `-p [--model M] --mode json --no-session --no-tools --no-context-files --no-skills --no-extensions`, prompt on stdin (its system prompt then lists tools "(none)"). JSON lines; a failed call exits 0 with `stopReason: error` and `errorMessage`, which becomes the cause.
- gemini: `-p "<marker> Follow the instructions above." [-m M] -o json --approval-mode plan --skip-trust -e none`, bundle on stdin. `--skip-trust` matters: in a folder it does not trust, gemini turns `plan` back to `default` ("Approval mode overridden"). Not offered: no headless write test has passed yet.
- acp:`<target>`: `acpx --cwd <run> --format json --json-strict --deny-all --allowed-tools "" --non-interactive-permissions deny [--model M] <runner_args.acp> <target> exec --file -`, prompt on stdin; the answer is the `agent_message_chunk` text. Not offered: live, `acpx ... pi exec` and `acpx --agent "opencode acp" exec` both wrote `x.txt` under `--deny-all` (the agents run their own tools without a permission request).

## How to get to it (user POV)
`learn-from-mistakes-axi agents` anywhere; `learn-from-mistakes-axi agents --test <runner>`
in a project with `.learn-from-mistakes.yaml`.

## Driving it with the public CLI
`test/runners.test.mjs` owns the journeys with fake `claude`, `codex`,
`opencode`, `pi`, `gemini` and `acpx` binaries (PATH holds only them): the listing (versions, login file
name without its canary contents, models from `src/models.json`, a broken shim,
`LFM_MODEL`), the judge clash (exit 1 and fix), each runner's exact argv, cwd,
marker and `OPENCODE_PERMISSION` (including `--test acp:fake-agent`), gemini and
acp listed as not offered and refused as pinned worker or judge, pi's exit-0 error,
an ACP agent that writes (exit 1), a global `runner_args` entry, and a hung (killed
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
lfm agents --test pi                                # the desktop's own pi login, read only
lfm agents --test gemini                            # the desktop's own gemini login, if any
LFM_HOME=$SCR/lfm-home lfm agents --test acp:pi     # config.yaml: runner_path.acp (a working acpx), runner_args.acp: [--model, <a ready model>]
ls -A .lfm/runs/test-*; git status --short
```

Each `--test` prints `reply` and `offered`, or the real
error (no gemini login: "Authentication cancelled by user"). `ls` shows no `x.txt` (only `prompt-<runner>.md`, and Codex's
`out-codex.txt`); `git status --short` shows only the 3 copied files.

## Gotchas
A mise shim on PATH resolves to mise itself, so two shimmed runners count as the
same binary (the identity rule then refuses, the safe side). A launcher script
that finds its runtime under `$HOME` fails `--version` under a lab HOME and is
"not usable" there. OpenCode keeps its session; later retros skip it by the
`lfm-run:` marker and the `.lfm/` run dir. Codex can still read files (R3).
Under a lab HOME, mise launchers (`~/.local/bin/<tool>`) install their tool into
that HOME on `--version` (slow; it stays in the scratch HOME); pi and gemini keep
their logins under the real HOME, so their legs run without `labenv`. A passing
`--test acp:<target>` does not make acp offered: the model may simply choose not
to write; the raw `acpx` probe that wrote is the evidence. The acpx built-in
`opencode` target runs `npx opencode-ai`, which can fail before initialize.
