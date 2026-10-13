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
finding and no fix it asks no agent (`nothing to verify: ...`). `check` reads the
verdicts ([propose.md](propose.md)): a refuted finding counts nothing, a refuted
fix is a problem, a fix the judge did not confirm (weakened, or left out: `not
judged`) ranks after the confirmed ones and `status` shows its verdict. A judge
on the worker's identity stops `retro` and `rerun` before the run starts (exit
2, `judge: ...` and the fix line); a judge that is not ready stops them the same
way (exit 1, `judge: <its problem>` and its fix line).

## How to get to it (user POV)
Set `agent:` and `judge_agent:`, each with its own `agent_config` model (the run
never picks one), then `learn-from-mistakes-axi retro --wait 20m` and
`logs --step verify`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journey `propose, verify and check: ...`, with the
fake agent as Claude Code (the worker) and as Codex (the judge, `gpt-6-luna`)
on the whole PATH, `FAKE_REFUTE=p2` and `FAKE_WEAKEN=p3`: the judge's argv,
run-dir cwd, marker, method, claim lines and the bundle at the end; the worker
never gets the verify marker; the `invocations` row (role `judge`, runner
`codex`); the finding `confirmed` with its note; claim p2 (the second proposal
row) `refuted` and a check problem, claim p3 `weakened` and kept fix 5; the log
lines; the next retro with no claim asks no agent. The journey `propose: ...`
refutes `f1`: its `count` and `days` stay empty. The journey `retro and rerun
stop ...` sets the judge to `claude` and to `acp:claude` on the worker's model:
exit 2, `judge: ...` and the fix line, no store. The helper's drives:
`retro-judge-clash` (`acp:claude`: exit 2), `retro-propose` (`FAKE_REFUTE=p2`,
`FAKE_WEAKEN=p3`: the verdicts, the kept fixes with theirs and the judge's
invocation row) and `logs-verify` (`refuted: p2`, `weakened: p3`, the counts).

Real-product proof (outside the repo; lab sessions only, never the captain's):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/tiny-notes   # a git repo with a synthetic defects.md (two causes, each on 2+ days) and its causes,
             # agent: byokit:opencode-go with agent_config model muse-spark-1.3-contributor,
             # judge_agent: an allowed BYOKit route (another agent and model), with its agent_config model
HOME=$LAB XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share lfm agents --test byokit:<judge route>   # the judge answers
HOME=$LAB XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share lfm retro --wait 20m && lfm logs --step verify
sqlite3 -readonly .lfm/lfm.sqlite 'select cause,verdict,judge_note from findings; select id,cause,verdict,judge_note from proposals'
sqlite3 -readonly .lfm/lfm.sqlite 'select step,role,runner,model,exit_status from invocations'
```

The run completes with 9 steps; one `verify` invocation with role `judge` on
the second agent; each finding and fix has a verdict and a reason. The lab
HOME and XDG dirs keep the judge's session out of the real store; the BYOKit
route owns its credentials (never read a desktop login into the environment).
Call `lfm` through the real node binary, not a mise shim, when HOME is the lab
HOME.

## Gotchas
The claim ids `f<n>` and `p<n>` count from 1 within the run; they are not
the `findings.id` or `proposals.id` row ids, and not the fix numbers `n`.
