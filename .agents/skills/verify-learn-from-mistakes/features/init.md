# init: config and detection (`init`)

## Sub-features
`src/init.mjs` writes the global `$LFM_HOME/config.yaml` (default `~/.learn-from-mistakes/config.yaml`) once when it is missing: every key commented, so it sets nothing (no agent, no model). It never overwrites; the JSON reports `global` and `global_status: written|kept`. It writes `.learn-from-mistakes.yaml` only when the project has none (`wx`, so it never overwrites); otherwise it prints `status: already set up` and the `gaps`.
The tool never picks an agent or a model: no automatic choice, no PATH scan, no built-in default model. The user chooses. `--agent <agent> [--model <model>]` and `--judge-agent <agent> [--judge-model <model>]` save exactly that into the project file (`agent`/`judge_agent` and `agent_config.<agent>.model`). On an existing project file they only fill a key not yet set: `init --agent claude --model M` on a file with no `agent` saves it; a key already set is never rewritten and its flags are listed in `ignored` (text: `--agent --model not applied: .learn-from-mistakes.yaml exists (edit it to change them)`), as is `--no-excerpts`; init exits 0 with the same bytes otherwise.
With no agent or judge_agent chosen (no flag, nothing in the file), init writes none. With `-y` it exits 0; without `-y` and not in a terminal it writes the files, then exits 2 with `error: ask the user which agent to use` and the `next:` save command. The JSON has `missing: [agent, judge_agent]`, the gaps list `agents: ask the user which agent to use: ...` and `next:` is `learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model> --dir <dir>   # with the user's answer` (only the unset roles are named). In a terminal (stdin and stdout TTYs) init instead asks: a pick list of the fixed supported agents (`claude`, `codex`, `opencode`, `pi` and the byokit routes, from `src/ask.mjs`; any `acp:<target>` or `byokit:<route>` can be typed), then the model, saves the answer into the project file and prints `saved: agent and judge_agent in <file>`; a judge on the worker's agent is asked again. `-y` asks nothing. Run from another process, such as an agent, it never asks: the agent asks the user and runs the `next:` command with the answer.
Refusals before any file is written (neither the project file nor the global file): a judge on the worker's identity (agent and model; exit 2, `judge: the judge resolves to the worker's agent and model, so it would judge its own work`), an unknown agent name (2), `--model` without `--agent` or `--judge-model` without `--judge-agent` (2), an opencode model that is not `provider/model` (2), and a chosen agent that is not usable or not offered (1: `worker:`/`judge:` and its `not usable`/`not offered` reason; a byokit route problem uses the route's own fix). A usable agent that is not offered (gemini and `acp:<target>`: tool-off mode not confirmed) is never resolved as worker or judge.
With a judge that resolves to the worker's identity in an existing file, it is a gap and `agents` exits 1 (no fallback to the worker); the fix is `set judge_agent in <file> to another agent the user chooses`. An agent set in the file that is not installed gets `install X, or set agent in <file> to another agent the user chooses`.
A `--dir` that is not a directory exits 2 with `error:`/`next:`.

Sources come from each registry module's `detect(dir)` hook (`src/sources/<type>.mjs`),
so only types with a reader are written: `markdown-log` takes the first of
`defects.md`, `docs/defects.md`, `DEFECTS.md` (as `log`); `no-mistakes` takes
`$NM_HOME/state.sqlite` (made absolute; else `~/.no-mistakes/state.sqlite`, written with `~`)
when its `repos` table has a row whose `working_path` is the project's git top
level or whose `upstream_url` is its `origin` URL (as `gate`); `sessions` is
written as `{ type: sessions, agents: [auto] }` when any agent session store exists
(store paths in [sessions.md](sessions.md)); `github` is written as `{ type: github }`
when `origin` is a GitHub repo and `gh auth status` passes ([github.md](github.md)). A detect hook returns
one config entry; init writes it under `log`, `gate`, `prs`, or else the type name. A store that
cannot be read is listed under `skipped` with its cause; init goes on.
`excerpts: on` is written (`--no-excerpts` writes `off`), and the text output
ends with one line naming the worker and judge agents that see redacted
excerpts. Init makes the state dir (`.lfm/` with its `*` `.gitignore`).
`--no-skill` is accepted (init installs no skill yet); `-y` asks nothing, even in a terminal.

## How to get to it (user POV)
`learn-from-mistakes-axi init` in any project dir (or `--dir <project>`).

## Driving it with the public CLI
`test/init.test.mjs` owns the journeys with fake `claude`/`opencode` binaries as
the whole PATH, a throwaway HOME and LFM_HOME, and a synthetic no-mistakes store
under `NM_HOME` with a `repos` row for the project: the written project config (`docs/defects.md`, the store and an empty session store detected), the global file, `.lfm/.gitignore`,
`git status`, a second init byte-identical, `retro --foreground` completing on
the written config with the chosen agents and models, the all-commented global file, gaps on an existing config, `--no-excerpts`,
init with no agent chosen (writes none, exit 0, `missing`, the ask `next:`; `retro`, `doctor` and `agents` then exit 2 with the same
`error: ask the user which agent to use` and `next:`), a terminal asked through a pseudo-terminal (`script`; the pick list,
the judge asked again when it is the worker's agent, `saved: agent and judge_agent in ...`), filling one unset key on an existing file
(`ignored` for a set one), the judge clash gap (and `agents` exit 1), and the refusals (judge on the worker's
identity, unknown agent, `--model` without `--agent`, opencode model without `provider/`, unusable or not-offered agent, a missing dir),
each writing no file; flags on an existing config exit 0 with the same bytes. The helper drives `init`,
`init-again` (bytes unchanged) and `init-pinned-clash` (exit 2) in a fresh
scratch project with two fake agents, and keeps `init.yaml` and `init-global.yaml`.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout,
`$LAB` a lab HOME holding only a link to the lab Claude credential; no agent is
called, so no tokens and no credential lock):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && labenv lfm init -y --no-skill; echo $?   # exit 0: no agent chosen, gaps `agents: ask the user ...`, next: init --agent <agent> --model <model> ...
labenv lfm retro --foreground; echo $?   # exit 2: error: ask the user which agent to use
labenv lfm init --agent claude --model <the user's model> --judge-agent codex --judge-model <the user's model> --no-skill
cat .learn-from-mistakes.yaml && git status --short
cat $LAB/.learn-from-mistakes/config.yaml   # the global file init wrote: every key commented; a second init keeps it
labenv lfm init                       # status: already set up, same bytes
git clone -q --no-local "$SELF" $SCR/self && cd $SCR/self && labenv lfm init -y --no-skill && git status --short
```

The agents and models are the user's answer (here a stand-in for it); the tool picks none. In a real
terminal, `labenv lfm init` with no flags asks the pick list and the model instead (run it under `script` to keep the transcript).
ky has no defect log and no no-mistakes row: `sources: {}`. `git status` shows
only `?? .learn-from-mistakes.yaml` (`.lfm` is ignored).

## Gotchas
Under a lab HOME, `NM_HOME` is unset, so `~/.no-mistakes` is the lab HOME's
(none): the store is not detected there. A mise shim resolves to mise itself,
so two shimmed runners are one identity (see [agents.md](agents.md)).
