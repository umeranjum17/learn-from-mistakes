# Propose and check steps

## Sub-features
`src/steps/propose.mjs` and its prompt `src/prompts/propose.md` are the
`propose` step, after `analyse`. It runs through the agent-step harness
([analyse.md](analyse.md)) on the worker. The prompt holds each cause with its
incidents and days and whether it repeated, the findings `analyse` kept, and
each applied change whose follow-up verdict is not `keep`; then the bundle.
The method: at most 5 fixes, only for a repeated cause, strongest first, "prefer
a check, a script or a deleted rule over more prose", one cause, target, owner
and change each, a metric and a tripwire, refs to bundle ids; a reason for each
listed follow-up, and never a verdict. The answer is `proposals` (cause, target,
owner, change of at most 3 sentences, metric, tripwire, refs) and `reasons`
(change id, reason of at most 25 words, one for each listed follow-up). A shape
or STE100 problem goes back once; on the second answer each proposal or reason that breaks a rule is dropped and logged as `dropped: ...`, and the valid ones are kept (only a top level that is not a `proposals` and `reasons` list fails the step). The fixes land in the store's `proposals`
table in the worker's order, the reasons in `followups.reason`. The step logs
`fixes: <n> proposed, reasons: <r> of <f> follow-ups`. With no finding and no
follow-up to explain it asks no agent (`nothing to propose: ...`).

`src/check.mjs` is the `check` step (plain code), and the v1 counting the
report uses (`repeats`). A cause repeats by `repeat:` over the run's labels
(duplicates and occurrences counted as v1), over the records and session events
a `match` rule tagged, or over the items a finding cites (a cluster ref counts
its events; the finding's `count` and `days` are saved; a finding the judge refuted
counts nothing and keeps them empty). A fix is kept when the judge did not refute it
(`the judge refuted it`), its cause has counted events and repeated, its refs name bundle items, and it has a
target, an owner, a metric (default `cause_count:<cause>`, else a metric name)
and a `"<op> <number>"` tripwire. A fix that breaks a rule is logged as
`problem: proposals[<i>]: <rule>`, saved with `proposals.problem` and not kept;
it is not sent back. Kept fixes are ranked by the judge's verdict (weakened after
the others), then by their cause's count, then by how
far their metric misses its target this window, then the worker's order, and
numbered 1 to 5 (`proposals.n`); one past five is
`more than 5 fixes: ranked below the top 5`. The step logs
`fixes: <k> kept of <n>, problems: <p>`. `status` lists the kept fixes as
`fixes` (n, cause, metric, tripwire, verdict). The delete rule (a flat rule change in 2
retros) is the follow-up verdict `delete` ([followup.md](followup.md)).

`change applied --proposal <run>:<n>` records the run's kept fix `n`: its
cause, metric and tripwire go into the ledger entry (`--metric`, `--tripwire`
override them). A fix that was not kept has no number: `run <run> has no kept
fix <n>`, exit 2; `--proposal` with `--cause` exits 2.

## How to get to it (user POV)
Set `agent:` and its model (the run never picks one), then
`learn-from-mistakes-axi retro --wait 15m`, `status` for the kept fixes,
`logs --step check` for the problems, and
`learn-from-mistakes-axi change applied --proposal <run>:<n> --ref <sha>` once
a fix is made.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journey `propose, verify and check: ...`, with the fake
Claude Code (`FAKE_PROPOSE=eight`) as the whole PATH and `repeat:
{ min_incidents: 2, min_days: 1 }`, `targets: { defects: "<= 0" }`: the propose
prompt's cause lines and method; the judge refutes fix 2 (`the judge refuted
it`) and weakens fix 3; 5 fixes that follow the rules are kept, the one with
metric `defects` (missing its target) ranked first and the weakened one last; a fix for a cause that did not repeat and one with no tripwire
are problems; the finding's count and days; `--proposal <run>:1` copies the
cause, metric and tripwire into the ledger, `--proposal <run>:6` exits 2; the
next retro asks the reason for the change's `no-data` follow-up and saves it;
`test/cli.test.mjs` also owns the journey `propose: a rule-breaking fix is sent
back once, then dropped on the second answer while the valid fixes are kept`,
with `FAKE_PROPOSE=long` (a four-sentence change on every answer): the step logs
`dropped: proposals[1].change has more than 3 sentences` and keeps the valid fix.
The helper's drives: `retro-propose` (`FAKE_PROPOSE=eight` for the gate's
repeated `agent-exit-wait`: 5 kept fixes, a reason for each follow-up),
`logs-check` (the 3 problem lines, the refuted fix first) and `change-proposal` (the ledger entry).

Real-product proof (outside the repo; lab sessions only, never the captain's):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky   # as analyse.md: lab sessions with a failing test, a cause matching it,
             # agent: byokit:opencode-go with agent_config model muse-spark-1.3-contributor
OPENCODE_API_KEY=$(node -p 'require(process.argv[1])["opencode-go"].key' ~/.local/share/opencode/auth.json) \
  lfm retro --wait 15m && lfm logs --step propose && lfm logs --step check
sqlite3 -readonly .lfm/lfm.sqlite 'select n,cause,metric,tripwire,problem from proposals'
sqlite3 -readonly .lfm/lfm.sqlite 'select step,role,runner,model,exit_status,tokens_in,tokens_out from invocations'
```

The run completes; each kept fix has a number, a cause that repeated, a metric
and a tripwire; a fix that broke a rule shows its rule.

## Gotchas
A fix for a cause key the config does not list can be kept with a metric such
as `defects`, but `change applied --proposal` then exits 2 with the unknown
cause: add the cause to the config first. The v1 `report` still checks
`proposals.jsonl`, not the run's fixes.
