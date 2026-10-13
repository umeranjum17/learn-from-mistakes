# Verify step (the judge)

## Sub-features
`src/steps/verify.mjs` and its prompt `src/prompts/verify.md` are the `verify`
step, after `propose` and before `check`. It runs through the agent-step harness
([analyse.md](analyse.md)) on the judge: `judge_agent` with its `agent_config`
model, never the worker (a judge on the worker's identity fails the step with
the fix line). The prompt lists each finding of `analyse` as `f<n>` and each fix
of `propose` as `p<n>` (table order), with its cause, text and refs; then the
bundle. The method: the worker's claims are not evidence; check each claim
against the bundle items it cites; answer `confirmed`, `weakened` or `refuted`
with a reason (at most 25 words). The answer is `verdicts` (item, verdict,
reason). A shape or STE100 problem, or a claim with no verdict, goes back once;
on the second answer each verdict that breaks a rule is dropped and logged as
`dropped: ...`, and a claim with no verdict stays not judged (NULL). The
verdicts land in `findings.verdict`/`judge_note` and
`proposals.verdict`/`judge_note`. The step logs only ids and verdicts:
`<verdict>: <id>` for each claim not confirmed, then
`verdicts: <c> confirmed, <w> weakened, <r> refuted, <u> not judged`. With no
finding and no fix it asks no agent (`nothing to verify: ...`). `check` does not
read the verdicts yet.

## How to get to it (user POV)
Set `agent:` and `judge_agent:`, each with its own `agent_config` model (the run
never picks one), then `learn-from-mistakes-axi retro --wait 20m` and
`logs --step verify`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journey `propose, verify and check: ...`, with the
fake agent as Claude Code (the worker) and as Codex (the judge, `gpt-6-luna`)
on the whole PATH and `FAKE_REFUTE=p2`: the judge's argv, run-dir cwd, marker,
method, claim lines and the bundle at the end; the worker never gets the verify
marker; the `invocations` row (role `judge`, runner `codex`); the finding
`confirmed` with its note; claim p2 (the second proposal row) `refuted`, the other 7 `confirmed`; the log
lines; the next retro with no claim asks no agent. The helper's drives:
`retro-propose` (`FAKE_REFUTE=p2`: the verdicts and the judge's invocation row)
and `logs-verify` (`refuted: p2` and the verdict counts).

Real-product proof (outside the repo; lab sessions only, never the captain's):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/tiny-notes   # a git repo with a synthetic defects.md (two causes, each on 2+ days) and its causes,
             # agent: byokit:opencode-go with agent_config model muse-spark-1.3-contributor,
             # judge_agent: opencode with agent_config model opencode-go/glm-5.3-flash (another agent and model)
export OPENCODE_API_KEY=$(node -p 'require(process.argv[1])["opencode-go"].key' ~/.local/share/opencode/auth.json)
HOME=$LAB XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share lfm agents --test opencode   # the judge answers, tools off
HOME=$LAB XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share lfm retro --wait 20m && lfm logs --step verify
sqlite3 -readonly .lfm/lfm.sqlite 'select cause,verdict,judge_note from findings; select id,cause,verdict,judge_note from proposals'
sqlite3 -readonly .lfm/lfm.sqlite 'select step,role,runner,model,exit_status from invocations'
```

The run completes with 9 steps; one `verify` invocation with role `judge` on
the second agent; each finding and fix has a verdict and a reason. The lab
HOME and XDG dirs keep the judge's OpenCode session out of the real store; the
key stays in the environment. Call `lfm` through the real node binary, not a
mise shim, when HOME is the lab HOME.

## Gotchas
The claim ids `f<n>` and `p<n>` count from 1 within the run; they are not
the `findings.id` or `proposals.id` row ids, and not the fix numbers `n`.
