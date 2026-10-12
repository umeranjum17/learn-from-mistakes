# init: config and detection (`init`)

## Sub-features
`src/init.mjs` writes `.learn-from-mistakes.yaml` only when the project has none
(`wx`, so it never overwrites); otherwise it prints `status: already set up` and
the `gaps`, and leaves the file byte-identical. The worker and judge come from the
runner table in `src/runners/index.mjs` (a runner added there is offered with no
init change) by the identity rule: the worker is the first usable runner, the
judge the first usable one whose (real binary, model) differs. The config gets
the runner and `model: ""` (the runner's default model). With one usable runner
and one table model, the judge is written on the worker's runner and reported as
a gap with the fix hint; `agents` then exits 1 (no fallback to the worker).
A usable runner that is not offered (gemini and `acp:<target>`: tool-off mode not
confirmed) is never picked; pinning one exits 1 with its `not offered:` reason.
`--worker`/`--judge <runner>` pin a role. A pinned judge steers the auto worker: the
worker is the first usable runner that differs from it (`--judge claude` with claude
and codex usable writes worker codex). Exit 2 when both are pinned and clash, or when a
pinned judge leaves no worker that differs from it; an unknown runner exits 2, a pinned
or auto role with no usable runner exits 1; none of these writes a file. On an existing
config, `--worker`, `--judge` or `--no-excerpts` change nothing: init exits 0 with
`already set up`, the gaps, the same bytes, and a line `--worker ... not applied`.
A `--dir` that is not a directory exits 2 with `error:`/`next:`.

Sources come from each registry module's `detect(dir)` hook (`src/sources/<type>.mjs`),
so only types with a reader are written: `markdown-log` takes the first of
`defects.md`, `docs/defects.md`, `DEFECTS.md` (as `log`); `no-mistakes` takes
`$NM_HOME/state.sqlite` (made absolute; else `~/.no-mistakes/state.sqlite`, written with `~`)
when its `repos` table has a row whose `working_path` is the project's git top
level or whose `upstream_url` is its `origin` URL (as `gate`); `sessions` is
written as `{ type: sessions, agents: [auto] }` when an agent session store exists
(Claude Code: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`). A detect hook returns
one config entry; init writes it under `log`, `gate`, or else the type name. A store that
cannot be read is listed under `skipped` with its cause; init goes on.
`excerpts: on` is written (`--no-excerpts` writes `off`), and the text output
ends with one line naming the worker and judge runners that see redacted
excerpts. Init makes the state dir (`.lfm/` with its `*` `.gitignore`).
`-y` and `--no-skill` are accepted; init asks nothing and installs no skill yet.

## How to get to it (user POV)
`learn-from-mistakes-axi init` in any project dir (or `--dir <project>`).

## Driving it with the public CLI
`test/init.test.mjs` owns the journeys with fake `claude`/`opencode` binaries as
the whole PATH, a throwaway HOME and LFM_HOME, and a synthetic no-mistakes store
under `NM_HOME` with a `repos` row for the project: the written config (worker,
different judge, `docs/defects.md`, the store and an empty session store detected), `.lfm/.gitignore`,
`git status`, a second init byte-identical, `retro --foreground` completing on
the written config, gaps on an existing config, `--no-excerpts`, the
one-agent judge gap (and `agents` exit 1), a pinned judge steering the worker,
and the refusals (pinned clash, unknown runner, unusable runner, a missing dir, no
agent CLI); flags on an existing config exit 0 with the same bytes. The helper drives `init`,
`init-again` (bytes unchanged) and `init-pinned-clash` (exit 2) in a fresh
scratch project with two fake agents, and keeps `init.yaml`.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout,
`$LAB` a lab HOME holding only a link to the lab Claude credential; no agent is
called, so no tokens and no credential lock):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && labenv lfm init -y --no-skill && cat .learn-from-mistakes.yaml && git status --short
labenv lfm init                       # status: already set up, same bytes
git clone -q --no-local "$SELF" $SCR/self && cd $SCR/self && labenv lfm init -y --no-skill && git status --short
```

ky has no defect log and no no-mistakes row: `sources: {}`. `git status` shows
only `?? .learn-from-mistakes.yaml` (`.lfm` is ignored).

## Gotchas
Under a lab HOME, `NM_HOME` is unset, so `~/.no-mistakes` is the lab HOME's
(none): the store is not detected there. A mise shim resolves to mise itself,
so two shimmed runners are one identity (see [agents.md](agents.md)).
