# Config v2 and the source registry

## Sub-features
`src/config.mjs` loads `.learn-from-mistakes.yaml` and `$LFM_HOME/config.yaml`.
v1 configs (`name`, `sources`, `causes`, `repeat`) load unchanged. The v2 keys
load with defaults and strict checks: `worker`/`judge` (`runner`: `auto`, `claude`,
`codex`, `opencode`, `pi`, `gemini`, `acp:<target>`, `byokit:<route>`; `model`: a
string), `window` (`<n>d`), `targets` (a known metric or `cause_count:<cause>` to a
quoted `"<op> <number>"`), `followup` (`min_sessions`, `min_days`), `excerpts`
(`on|off`), `caps` (`invocations`, `bundle_chars`, `timeout` such as `20m`),
`signoff` (`auto|off`), `allow_premium` (boolean). The global file adds
`runner_path: {<runner>: <bin>}` (a bare name stays a PATH lookup) and `runner_args: {<runner>: [..]}`. An unknown key
or a bad value exits 2 with `error: <file>: <key> must be ...`. The keys are only
loaded and checked: only the sessions source reads `excerpts`; nothing reads the runners or the caps yet.

Sources come from a registry: one file per type in `src/sources/<type>.mjs`
exporting `validate` (its own keys), `read` and `detect` (init); `collect`/`ingest` call the
registry. Today: `markdown-log` and `no-mistakes`, unchanged, and `sessions`
([sessions.md](sessions.md)). A type with no reader yet (`github`) exits 2
`sources.<id>.type must be one of ...`. `window` sets the sessions read range and the metrics windows. A cause's `match`
names a no-mistakes source (`error_contains`) or a sessions source (any of `signal`,
`tool`, `text_contains`); other keys, a rule with none of the three, an unknown
signal or another source type exit 2 ([metrics.md](metrics.md)).

## How to get to it (user POV)
Add v2 keys to `.learn-from-mistakes.yaml`, then `learn-from-mistakes-axi retro --wait 8m`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journeys: the `retro --foreground ...` journey runs a
config with every v2 key plus a global `runner_path`/`runner_args` (3 completed
steps) and a bad global `runner_args` (exit 2); `every rejected input ...` holds a
row per bad v2 key (`worker: { runner: 3 }` names `worker.runner`); `an unreadable
source ...` covers a source without `path` and an unregistered type. The helper
drives `retro-v2` (v2 keys on the staged examples) and `config-bad-runner`
(`worker: { runner: 3 }`, exit 2).

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
cat >> .learn-from-mistakes.yaml <<'YAML'
worker: { runner: auto, model: "" }
judge: { runner: auto, model: "" }
window: 7d
targets: { first_pass: ">= 70", escaped: "<= 0" }
followup: { min_sessions: 3, min_days: 2 }
excerpts: on
caps: { invocations: 12, bundle_chars: 60000, timeout: 20m }
signoff: auto
allow_premium: false
YAML
lfm retro --foreground && lfm runs && git status --short
```

The run is `completed` with 3 steps and collect reads 13 log and 5 gate items.
Then `worker: { runner: 3 }` exits 2 naming `worker.runner`. Repeat in a scratch
copy of `$SELF/examples`.

## Gotchas
`>= 70` must be quoted in YAML (a bare `>` starts a block scalar). `on`/`off`
are strings in YAML 1.2. A source may export `metricNames`, `metricRows`, `metrics`, `detect` and `doctor`
(the sessions and markdown-log sources export metrics; `metricRows` says which rows they read); `init` calls `detect`
([init.md](init.md)), doctor calls `doctor` in a later slice.
