# Config v2 and the source registry

## Sub-features
`src/config.mjs` loads `.learn-from-mistakes.yaml` and the global `$LFM_HOME/config.yaml` (default `~/.learn-from-mistakes/config.yaml`), in the same config shape as no-mistakes.
v1 configs (`name`, `sources`, `causes`, `repeat`) load unchanged. The agent keys load with strict checks and no defaults: `agent` and `judge_agent` (`claude`, `codex`, `opencode`, `pi`, `gemini`, `acp:<target>`, `byokit:<route>`, one agent each, never a list (a list exits 2) and never another agent when the one set is not ready; `auto` is not a value and exits 2; unset, or an agent with no model, means the user has not chosen, and the tool never picks: see [init.md](init.md)), `agent_config.<agent>` (no built-in model for any agent; `model`: a string; `effort`: `minimal|low|medium|high|xhigh|max`, refused for gemini, acp and byokit; an opencode model is `provider/model`), `agent_timeout` (`<n>s|m|h`, such as `20m`), `allow_premium` (boolean) and `auto_fix` (a whole number, 0 or more; 0 by default; global only). A project file may set the five keys other than `auto_fix`; `agent_path_override`, `agent_args_override`, `acpx_path` and `state_root` are global-only and exit 2 `<key> is global-only: set it in <global file>` in a project file, and a project `auto_fix` exits 2 `auto_fix is global-only: set it in <global file>`. The rest of the v2 keys load with defaults and strict checks: `window` (`<n>d`), `targets` (a known metric or `cause_count:<cause>` to a quoted `"<op> <number>"`), `followup` (`min_sessions`, `min_days`), `excerpts` (`on|off`), `caps` (`invocations`, `bundle_chars`), `signoff` (`auto|off`). An unknown key (the retired role keys, the runner path and args keys, or the caps timeout) or a bad value exits 2 with `error: <file>: <key> must be ...`. The keys are only loaded and checked: the sessions and github sources and the bundle step read `excerpts`; the bundle step reads `caps.bundle_chars`; `agents`, `init`, `doctor`, `retro` and `rerun` resolve `agent`/`judge_agent`; `agent_timeout` bounds each agent call; the analyse step runs `agent` as the worker and stops at `caps.invocations` agent calls ([analyse.md](analyse.md)).

Sources come from a registry: one file per type in `src/sources/<type>.mjs`
exporting `validate` (its own keys), `read` and `doctor`; `detect` (init) is optional, and `done-done`
has none, so `init` never writes it. `collect`/`ingest` call the
registry. Today: `markdown-log` and `no-mistakes`, unchanged, `sessions`
([sessions.md](sessions.md)), `github` ([github.md](github.md)) and `done-done` ([done-done.md](done-done.md)). A type outside the
registry exits 2 `sources.<id>.type must be one of ...`. `window` sets the sessions read range and the metrics windows. A cause's `match`
names a no-mistakes source (`error_contains`) or a sessions source (any of `signal`,
`tool`, `text_contains`); other keys, a rule with none of the three, an unknown
signal or another source type exit 2 ([metrics.md](metrics.md)).

## How to get to it (user POV)
Add v2 keys to `.learn-from-mistakes.yaml`, then `learn-from-mistakes-axi retro --wait 8m`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journeys: the `retro --foreground ...` journey runs a
config with every agent and v2 key, a global `agent_path_override` and `agent_args_override`
(9 completed steps) and a bad global `agent_args_override` (exit 2); `every rejected input ...`
holds a row per bad key (`agent: 3` names `agent`; the retired `worker` role form is an unknown key;
`agent_path_override` in a project file is global-only); `an unreadable
source ...` covers a source without `path` and an unregistered type. The helper
drives `retro-v2` (every agent and v2 key on the staged examples) and `config-bad-agent`
(`agent: 3`, exit 2 naming `agent`).

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
cat >> .learn-from-mistakes.yaml <<'YAML'
agent: claude
judge_agent: codex
agent_config: { claude: { model: <model> }, codex: { model: <model> } }
window: 7d
targets: { first_pass: ">= 70", escaped: "<= 0" }
followup: { min_sessions: 3, min_days: 2 }
excerpts: on
agent_timeout: 20m
caps: { invocations: 12, bundle_chars: 60000 }
signoff: auto
allow_premium: false
YAML
lfm retro --foreground && lfm runs && git status --short
```

The run is `completed` with 9 steps and collect reads 13 log and 5 gate items.
Then `agent: 3` exits 2 naming `agent`. Repeat in a scratch
copy of `$SELF/examples`.

## Gotchas
`>= 70` must be quoted in YAML (a bare `>` starts a block scalar). `on`/`off`
are strings in YAML 1.2. A source may export `metricNames`, `metricRows`, `metrics`, `detect` and `doctor`
(the markdown-log, sessions and github sources export metrics; `metricRows` says which rows they read); `init` calls `detect`
([init.md](init.md)), and `doctor` calls each source's `doctor` hook ([doctor.md](doctor.md)).
