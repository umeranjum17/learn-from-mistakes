# Analyse step and the agent-step harness

## Sub-features
`src/steps/agent-step.mjs` is the harness every agent step runs through. Its role
(`worker` or `judge`) is the agent the user set in the config, resolved by the
identity rule ([agents.md](agents.md)); the run never picks one. It calls the agent in `.lfm/runs/<id>/` with the step's
prompt and then `bundle.md` ([bundle.md](bundle.md)), behind the `lfm-run:<id>:<step>`
marker. It checks the JSON answer with the step's own check. A bad answer (an empty one
too) goes back once with the problems; a second bad answer fails the step (exit 1) with
`the worker's answer is not valid after one retry: <problems>`. Each call is one
`invocations` row: step, role, runner, model, the agent's process group and its start time while it
runs, `exit_status` (`ok`, `invalid`, `error`, or the run's `cancelled` or
`interrupted`), session id and tokens in and out when the agent reports them.
A run makes at most `caps.invocations` calls; one more exits 1 with
`caps.invocations reached: run <id> already made <n> agent calls`.

`src/steps/analyse.mjs` and its prompt `src/prompts/analyse.md` are the
`analyse` step, after `bundle`. The prompt holds the retro method: hunt hidden
problems first, a shared keyword is not a shared cause, a consequence is not a
repeat, label only what you read, the v1 label rules and STE100 free text (at
most 20 words a sentence). The worker answers `findings` (cause key, summary of
at most 3 sentences, refs to bundle ids) and `labels` (one per record under
"Unlabelled defect records": `event`, a config cause or `other` for an event,
`why` of at most 25 words, optional `duplicate_of`, `occurrences`, `confidence`).
They land in the store's `findings` and `labels` tables, and the run's `report`
step counts with these labels instead of `labels.jsonl` (kept for a run with none). A ref, label id or
`duplicate_of` that names no bundle item is a problem: it is logged as
`problem: ...` and that finding or label is not kept; it is not sent back.
The step logs `labels: <n> of <m> records, <d> dropped, findings: <f>, problems: <p>`.
A bundle with no cluster, event or record id asks no agent
(`nothing to analyse: ...`), so the example journeys make no agent call. A worker (`agent`) that is not set, or has no `agent_config` model, stops the retro before it starts with the ask line (exit 2); one that does not resolve fails the step (exit 1) with one fix line naming the config file and `agent`: the run never picks an agent.

## How to get to it (user POV)
Set `agent:` and its `agent_config` model in `.learn-from-mistakes.yaml` (the run never picks one), then
`learn-from-mistakes-axi retro --wait 15m` and `logs --step analyse`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journey `analyse: the worker labels the bundle's
records ...`, with the fake Claude Code in `test/fake-agent/claude` as the whole
PATH (plus node and git): the argv, the run-dir cwd, the marker and the bundle at
the end of the prompt; the `labels`, `findings` and `invocations` rows (tokens
12 in, 5 out); a ref to `c99` is a problem; prose twice fails the step with
2 `invalid` rows and the retry prompt; the report step counts the 2 labels with no
`labels.jsonl`; a third call past `caps.invocations: 3`
fails; a hung agent's process group is gone after its worker is killed, and a
group whose leader is another process is never signalled; a worker that is not
set, or set to an agent not on PATH, stops the run with the fix line.
`test/github.test.mjs` checks a record id whose source id holds `token` is
printed raw in the bundle and labelled as the store keeps it.
The helper's drives run on the same fake PATH: `retro-analyse` (`FAKE_ANALYSE=label`)
checks the kept finding and the invocation row, `logs-analyse` the problem line,
`retro-analyse-prose` exits 1 and `logs-analyse-prose` shows the validation error.

Real-product proof (outside the repo; lab sessions only, never the captain's):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky   # a test command that fails unless UMER_FIXTURES=1, a cause matching it,
             # agent: "byokit:opencode-go", judge_agent: claude, agent_config: { "byokit:opencode-go": { model: <model> },
             # claude: { model: <model> } } (or agent: opencode with model <provider>/<model>)
for ask in ...; do opencode run -m <provider>/<model> "$ask, and run the tests"; done
OPENCODE_API_KEY=$(node -p 'require(process.argv[1])["opencode-go"].key' ~/.local/share/opencode/auth.json) \
  lfm retro --wait 15m && lfm logs --step analyse
sqlite3 -readonly .lfm/lfm.sqlite 'select step,role,runner,model,exit_status,tokens_in,tokens_out from invocations'
sqlite3 -readonly .lfm/lfm.sqlite 'select cause,refs_json from findings; select record_id,event,cause from labels'
```

The run completes; the finding names the env-var cause with refs to its cluster;
the report step's coverage counts the worker's labels. A BYOKit call has no
process group or session id; its tokens come from the provider's usage.

## Gotchas
Only a shape or STE100 problem is sent back; a bad ref is dropped, so a run
with a hallucinated id still completes. `caps.invocations` counts calls, not the
transient retries inside one call. The fake agent never runs on the host PATH:
the default helper journey makes no model call.
