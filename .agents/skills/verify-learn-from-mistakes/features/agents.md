# Agent runners (`agents`, `agents --test <runner>`, `byokit:<route>`)

## Sub-features
`src/runners/index.mjs` holds the runner table (claude, codex, opencode, pi, gemini,
acp; acp runs as `acp:<target>` through the `acpx` binary). The tool never picks an agent or a model: `agent`, `judge_agent` and `agent_config.<agent>.model` are the user's, with no default model for any agent (see [init.md](init.md) for the ask). A runner is usable when its binary (global `agent_path_override`, else an absolute PATH entry) runs
`--version` with exit 0; a broken shim is not usable and shows the cause. A usable
runner whose tool-off mode is not confirmed live (gemini, acp) has `problem:
not offered: <why>` and is never resolved as worker or judge (a pinned one gives
`problem: worker: gemini is not offered: ...`); `--test` still runs on it (a pass does not offer it). An acp target is a plain
name (`[a-z0-9][\w.-]*`): it names the run dir, so a path or `..` exits 2.
`agents` lists only the configured agents (the ones `agent` and `judge_agent` name; never other installed ones) and prints each: usable, version, tools (`off`, `read-only` for
Codex and Gemini, or `unconfirmed` for acp), login presence (file and variable names only, never contents), the
model (`agent_config.<agent>.model`, empty when the user set none) and the real binary path. With a project config it adds the
resolved `worker` and `judge` by the identity rule (real binary path + model; a
role with no model is never compared); a judge clash exits 1 with `problem:`
and the fix. `agents` with an unset role asks like `init` (a terminal: pick list, model, `saved: ... in <file>`, to the project file, or the global file when the directory has no project file; otherwise exit 2 `error: ask the user which agent to use: ...` and the `next:` init command). A role that does not resolve exits 1 with a hint: `install X, or ask the user which agent and model to use, then set agent and its agent_config model in <file>; the run never picks one` only when X is not installed, `ask the user which agent and model to use, then set agent and its agent_config model in <file>; the run never picks one` when it is installed but not offered, and for a judge on the worker's identity `ask the user which agent and model to use, then set judge_agent and its agent_config model in <file>; the run never picks one`. `agents --test <runner>` refuses an empty model for every agent: `<agent>: no model set in agent_config` (a byokit route says `byokit:<route>: no model set in agent_config`); the fix names the agent and its agent_config model in <file>. Otherwise it makes one live call in
`<state dir>/runs/test-<runner>/`: the prompt starts with `lfm-run:test:<runner>`
and asks the agent to write `x.txt`; any new file in the run dir, no answer within
`agent_timeout` in an attempt (each attempt has its own; a call makes at most 3 attempts) or the agent's own error exits 1 with the
real cause; a plain-text answer with no JSON passes and prints as `reply` (the file scan is the check). Transient errors (429/503/529, overloaded, rate_limit, ECONNRESET)
retry twice; quota text never retries. The agent process group is killed at the
timeout (SIGTERM, SIGKILL after 3 s); after exit a grandchild holding stdout gets
5 s before the pipes close.

BYOKit runner (`src/runners/byokit.mjs`, optional packages `@byokit/accounts`,
`@byokit/secrets` and `@earendil-works/pi-ai`, loaded only for it): `byokit:<route>`
as `agent`/`judge_agent` or `agents --test byokit:<route>` makes one plain
model call in process, no agent CLI, tools `none`. Its role identity is the route
plus model. Two kinds of route:
- sign-in plans `byokit:chatgpt` and `byokit:claude`: the sign-in in this
  computer's BYOKit machine store (member `lfm`, seal service `byokit`). No model
  set: refused (`no model set in agent_config`); the user names the model. Signed out: exit 1 with BYOKit's words and
  a sign-in `next:`.
- plan key routes from BYOKit's route list (`via: plan_key` aliases, such as
  `byokit:opencode-go`): the key from the variable the route names
  (`OPENCODE_API_KEY`), held in an in-memory key store with an in-memory account
  index for the one call, so nothing reaches a BYOKit store; the pi-ai model from
  pi-ai's built-in list (the `agent_config` model, which a route always needs; an unknown one names
  itself). OpenCode Go also gets an `x-opencode-session` header, which BYOKit's
  key call drops (gap 6 in the evidence). Key not set: exit 1 and `next: set
  OPENCODE_API_KEY to your OpenCode Go key`.
Any other name is refused before a call, with the ready plan routes (the sign-in plans and the plan key routes whose BYOKit readiness is `ready`). As worker or judge it is a `problem:` in `agents` (exit 1, the same list). With BYOKit not installed, the role's problem carries BYOKit's own install command as the fix. A busy
provider (BYOKit `overloaded`/`network`, or 429/503/529 text) retries twice. Its
doctor hook `doctor(route)`, which `doctor` calls, returns the route's row (the sign-in
state from `accounts.status`, or whether the key variable is set; no paid call; a
missing package gives the install command). The Node floor is `doctor`'s own `node` check.
`LFM_TEST_BYOKIT_BASE` (tests only) points BYOKit's `apiBase`, or a key route's
model `baseUrl`, at a stand-in.

Argv (confirmed live on claude 2.1.296, opencode 1.18.25 and pi 1.0.0; codex, gemini 0.56.0 and acpx 0.19.3 from `--help` and source):
- claude: `-p --output-format json [--model M] --tools "" --no-session-persistence --strict-mcp-config`, prompt on stdin. Not `--bare`: it never reads an OAuth login ("Not logged in").
- codex: `exec [-m M] -s read-only --ephemeral --skip-git-repo-check -o <run>/out-<step>.txt -`, prompt on stdin.
- opencode: `run [-m M] --format json --dir <run> -f <run>/prompt-<step>.md -- "<marker> Follow the instructions in the attached file."` with `OPENCODE_PERMISSION={"*":"deny"}` (it then has no tools: "Available tools: .").
- pi: `-p [--model M] --mode json --no-session --no-tools --no-context-files --no-skills --no-extensions`, prompt on stdin (its system prompt then lists tools "(none)"). JSON lines; a failed call exits 0 with `stopReason: error` and `errorMessage`, which becomes the cause.
- gemini: `-p "<marker> Follow the instructions above." [-m M] -o json --approval-mode plan --skip-trust -e none`, bundle on stdin. `--skip-trust` matters: in a folder it does not trust, gemini turns `plan` back to `default` ("Approval mode overridden"). Not offered: no headless write test has passed yet.
- acp:`<target>`: `acpx --cwd <run> --format json --json-strict --deny-all --allowed-tools "" --non-interactive-permissions deny [--model M] <agent_args_override.acp> <target> exec --file -`, prompt on stdin; the answer is the `agent_message_chunk` text. Not offered: live, `acpx ... pi exec` and `acpx --agent "opencode acp" exec` both wrote `x.txt` under `--deny-all` (the agents run their own tools without a permission request).

## How to get to it (user POV)
`learn-from-mistakes-axi agents` anywhere; `learn-from-mistakes-axi agents --test <runner>`
in a project with `.learn-from-mistakes.yaml`.

## Driving it with the public CLI
`test/runners.test.mjs` owns the journeys with fake `claude`, `codex`,
`opencode`, `pi`, `gemini` and `acpx` binaries (PATH holds only them): the listing of only the configured agents (versions, login file
name without its canary contents, models from `agent_config`, a broken shim), the judge clash (exit 1 and fix), each runner's exact argv, cwd,
marker and `OPENCODE_PERMISSION` (including `--test acp:fake-agent`), gemini and
acp listed as not offered and refused as pinned worker or judge, pi's exit-0 error,
an ACP agent that writes (exit 1), a global `agent_args_override` entry, and a hung (killed
at `agent_timeout: 10s`), leaking (grandchild holds stdout), writing (`x.txt`,
exit 1) and overloaded-once (retried) agent. The `byokit:` journeys run the real
CLI against BYOKit's stand-in OpenAI (`mockOpenAI`) with a sign-in seeded into the
throwaway HOME's machine store (DBus pointed at a missing socket, so the seal is a
host key file there and no session keyring is touched): signed out (exit 1 and
the sign-in fix), the doctor hook before and after sign-in, one `--test` call
(the model set in `agent_config`, marker in the input, only `prompt-byokit-chatgpt.md` in the
run dir), a busy-once retry, a byokit judge beside a claude worker, the same route
as worker and judge (clash); `byokit:opencode-go` against a local Responses
stand-in (the `agent_config` model; no key: exit 1 and the fix, no request; then one call
with `Bearer <key>`, a session header, the model, the marker, only the prompt file
in the run dir and no BYOKit store in HOME; an unknown `agent_config` model), grok (refused with
the route list, and as a worker `agents` exits 1 with that `problem:`), a `--test` of a byokit route with no model set (exit 1, `no model set in agent_config`), a configured agent CLI not on PATH
(`next: install X, or ask the user which agent and model to use, then set agent and its agent_config model in <file>; the run never picks one`), `agents` with no agent set (exit 2, the ask), pi with no model,
and the hook from a copy with no `node_modules` (install command). The helper drives `agents --json`
on the host PATH in its scratch HOME to capture evidence (no live call).

Real-product proof (outside the repo; small cost; `$SCR` scratch, `$SELF` this checkout,
`$LAB` a lab HOME holding only a link to the lab Claude credential):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
labenv lfm agents; echo $?                         # no agent set: exit 2, error: ask the user which agent to use, next: init --agent ...
labenv lfm init --agent claude --model <the user's model> --judge-agent codex --judge-model <the user's model> --no-skill
labenv lfm agents                                  # only claude and codex, and the resolved worker and judge
labenv <credential lock> lfm agents --test claude   # one Claude run at a time on the lab credential
labenv lfm agents --test codex
lfm agents --test opencode                          # the desktop's own OpenCode login, read only
lfm agents --test pi                                # the desktop's own pi login, read only
lfm agents --test gemini                            # the desktop's own gemini login, if any
LFM_HOME=$SCR/lfm-home lfm agents --test acp:pi     # config.yaml: acpx_path (a working acpx), agent_config: { "acp:pi": { model: <a ready model> } }
ls -A .lfm/runs/test-*; git status --short
```

BYOKit (live, small cost; a lab BYOKit sign-in for member `lfm` in `$LAB`, never the
captain's store; DBus pointed nowhere so the seal stays a host key file under `$LAB/.local/state`):

```sh
labenv env DBUS_SESSION_BUS_ADDRESS=unix:path=$SCR/no-bus XDG_STATE_HOME=$LAB/.local/state lfm agents --test byokit:chatgpt
labenv env DBUS_SESSION_BUS_ADDRESS=unix:path=$SCR/no-bus XDG_STATE_HOME=$LAB/.local/state node --input-type=module \
  -e 'console.log(JSON.stringify(await (await import(process.argv[1])).doctor("chatgpt")))' $SELF/src/runners/byokit.mjs
```

BYOKit plan key route (live, small cost): the desktop's own OpenCode Go key, read in
place into the one command's environment (never copied, linked or saved; never
printed), with the model the user names in `agent_config` (a route needs one; the tool picks no route):

```sh
OPENCODE_API_KEY=$(node -p 'require(process.argv[1])["opencode-go"].key' ~/.local/share/opencode/auth.json) \
  lfm agents --test byokit:opencode-go
```

Each `--test` needs a model set for that agent in `agent_config` (the user's). Each `--test` prints `reply` and `offered`, or the real
error (no gemini login: "Authentication cancelled by user"). `ls` shows no `x.txt` (only `prompt-<runner>.md`, and Codex's
`out-codex.txt`); `git status --short` shows only the 3 copied files.

## Gotchas
A mise shim on PATH resolves to mise itself, so two shimmed runners count as the
same binary (the identity rule then refuses, the safe side). A launcher script
that finds its runtime under `$HOME` fails `--version` under a lab HOME and is
"not usable" there. OpenCode and Gemini keep their sessions; later retros skip them by the
`lfm-run:` marker and the `.lfm/` run dir. Codex can still read files (R3).
Under a lab HOME, mise launchers (`~/.local/bin/<tool>`) install their tool into
that HOME on `--version` (slow; it stays in the scratch HOME); pi and gemini keep
their logins under the real HOME, so their legs run without `labenv`. A passing
`--test acp:<target>` does not make acp offered: the model may simply choose not
to write; the raw `acpx` probe that wrote is the evidence. The acpx built-in
`opencode` target runs `npx opencode-ai`, which can fail before initialize.
