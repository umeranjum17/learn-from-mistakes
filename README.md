<p align="center"><img src="docs/logo.svg" width="96" height="96" alt="learn-from-mistakes logo"></p>

<h1 align="center">learn-from-mistakes</h1>

<p align="center">Find the mistakes your coding agents keep repeating, with evidence and a short list of changes to stop them.</p>

<p align="center"><b><a href="https://umeranjum17.github.io/learn-from-mistakes/">Landing page</a></b> · <a href="https://www.npmjs.com/package/learn-from-mistakes-axi">npm</a> · part of the family with <a href="https://github.com/umeranjum17/sign-off">sign-off</a>, <a href="https://github.com/umeranjum17/first-draft">first-draft</a> and <a href="https://github.com/umeranjum17/done-done-axi">done-done</a></p>

<p align="center"><img src="docs/media/retro.webp" width="560" alt="Terminal: the end of a retro run, with two repeated causes and three findings with the judge's verdicts"></p>

`learn-from-mistakes-axi` runs a saved retrospective on a project's defect logs, failed checks and agent sessions. Its own worker reads the records and names findings. A judge role checks each finding, then the worker proposes fixes for the findings the judge did not refute, and the judge checks each fix. The CLI merges duplicates, counts repeated causes and writes a plain-text report.

You, or your calling agent, start the retro and read its report. **Do not label or judge records yourself.** Unread records stay unlabelled, not guessed. Recommendations do not change your project by default.

**The worker and the judge always run.** There is no judge-less or agent-less mode. With no agent set, the command stops and asks you to set one. If an agent is not ready, the retro does not start. If the worker or the judge fails, or the judge leaves a claim without a verdict, the run fails with an error and a `next:` line. A run that does not complete keeps no verdict, label, finding or fix.

## Install in 3 steps

Requires Node **22.13+**, project records to read, and a ready agent for each of the two roles, with models **you choose**; one agent may run both roles. Install and sign in to those agents yourself. No skill, sign-off service or fleet manager is required.

```sh
# 1. Install
npm install -g learn-from-mistakes-axi

# 2. Set up, in your project
cd /path/to/your/project
learn-from-mistakes-axi init --no-skill
learn-from-mistakes-axi doctor

# 3. Run the retro and read the report
learn-from-mistakes-axi retro --wait 8m
learn-from-mistakes-axi status
learn-from-mistakes-axi report
```

<p align="center"><img src="docs/media/doctor.webp" width="560" alt="Terminal: learn-from-mistakes-axi doctor lists ok lines for node, git, config, source, worker, judge and sign-off"></p>

1. `init` asks for the worker, judge and their models in a terminal. It writes `.learn-from-mistakes.yaml` and a fully commented `$LFM_HOME/config.yaml` (default `~/.learn-from-mistakes/config.yaml`). It detects supported sources, adds four editable starter causes, and asks which local agents' sessions you want read; none are preselected. Inspect the written sources before starting a retro.
2. `doctor` checks config, sources, state, agents, login presence and model choices without calling a model. Follow each `fix:` under a `fail`, then run it again. A missing skill or sign-off peer is a warning, not a prerequisite.
3. `retro --wait 8m` starts a background worker and waits up to eight minutes. **A return with `running` is not completion.** The worker continues after the terminal or calling agent ends. Run `learn-from-mistakes-axi attach` to follow it until it ends, or poll `status`. Do not start another retro while it runs.
4. After `completed`, `report` prints the saved run's counts, verdicts and `report_txt` path. Open that file, normally `.lfm/runs/<id>/report.txt`, with your editor or `cat`. This is the report to read, not the compact stdout summary.

The report contains a short answer, numbers, follow-ups on previous changes, repeated mistakes with evidence, checked fixes, what was not checked, and questions for you. An empty result is not proof that nothing went wrong: check its coverage and omissions.

<p align="center"><img src="docs/media/report.webp" width="560" alt="Terminal: report.txt with seven sections, from a short answer to repeated mistakes, fixes and questions for you"></p>

The report follows a blameless retro method. Section 2 gives every number with this window, the last window and a trend (up, down, flat or unknown). Section 3 checks whether each past fix worked, with the number before and after, and says what to roll back. Section 4 gives each repeated mistake its cost, how often it came back, the why chain down to its root cause and its fix. The worker must give each finding a chain of 3 to 5 whys and a cost, in wording that names a process, rule, tool or check and never a person or an agent; the judge checks the chain, and a finding without them is not kept (the report then says "No finding gave" a cost or root cause).

The shots on this page come from a real run of the packed CLI on a small sample defect log, with MiniMax-M3 as both the worker and the judge, called through BYOKit; only the project path is shortened. A model can say different things about your project.

### No terminal, or no agent/model selected?

Without a terminal, missing choices stop with exit **2** and an `ask the user` / `next:` line. Ask for both roles and their model names; never pick a fallback. With the user's answers in `WORKER`, `WORKER_MODEL`, `JUDGE` and `JUDGE_MODEL`, replace step 2's init command with:

```sh
learn-from-mistakes-axi init --no-skill \
  --agent "$WORKER" --model "$WORKER_MODEL" \
  --judge-agent "$JUDGE" --judge-model "$JUDGE_MODEL"
```

Then run `doctor`, `retro`, `attach` or `status`, and `report` as above. These variables are your inputs, not suggested defaults. The judge may run on the worker's agent (see `Runners and user-chosen models`).

`init -y --no-skill` can write config without asking, but it does **not** choose agents or make the project ready. Follow its gaps. A second `init` keeps existing choices; flags can fill missing project choices, not replace them. `init --reconfigure` is the one exception: it re-applies `--agent`, `--model`, `--judge-agent`, `--judge-model` and `--sessions` to an existing config, replacing those keys while every other key and comment stays. Edit existing keys explicitly if you want to change anything else.

If no source was found, configure one before running retro. For a defect log:

```yaml
# In .learn-from-mistakes.yaml; keep the other keys init wrote.
sources:
  log: { type: markdown-log, path: defects.md }
```

Each `- ` bullet is a record. A `YYYY-MM-DD` in the bullet dates it; otherwise its dated `##` heading does — `YYYY-MM-DD`, `12 Oct 2026`, `12 October 2026`, `Oct 12, 2026`, or a year-less `12 Oct` / `12 October`, which take the latest year that keeps the date on or before today. Only records dated inside the `window` (default `7d`) are read: older ones count as "0 in the window" in `doctor`, and the retro completes with no findings. Use actual project records, not invented failures. `init` also detects `reviews.md` and supported local pipeline stores; GitHub needs a GitHub origin and a working `gh` login. Session stores are read only when you name their agents, for example `init --sessions claude,pi --no-skill`.

A `markdown-log` source with `review: true` is a review log: its records do not count as `defects`; a source id of `reviews` without the flag keeps the old behavior and is still treated as a review log.

### Run through a calling agent

Without installing globally, use `npx -y learn-from-mistakes-axi <command>` for any command above. Ask your agent to run `guide`, then drive init → doctor → retro → report and read `report.txt` to you. The caller does not perform the retro's analysis.

The optional discovery skill uses the [Agent Skills](https://agentskills.io) format. Omit `--no-skill` from init to install it for configured usable agent CLIs; `--project-skill` installs project-local copies instead. The skill is named `lfm-retro`; init moves a `learn-from-mistakes` skill dir it wrote earlier to `lfm-retro` once and leaves any other skill alone. In harnesses with slash commands, invoke `/lfm-retro`. The skill points to the installed CLI's `guide` and `--help`, not a separate manual workflow.

## Alone, with the family, inside or outside Firstmate

Each tool works on its own, with or without the other three and with or without an agent supervisor. They meet through small written contracts, and none reaches into another's state.

- **Alone:** the 3 steps above are the whole setup. A defect log or your agents' own sessions are enough.
- **With [sign-off](https://github.com/umeranjum17/sign-off):** `signoff post` sends each kept fix to the sign-off board as an Apply or Skip choice, and `signoff answers` saves your answers. See `Sign-off` below.
- **With [done-done](https://github.com/umeranjum17/done-done-axi):** a `done-done` source reads the failed, inconclusive or overridden steps of its verify runs as retro records.
- **With [first-draft](https://github.com/umeranjum17/first-draft):** no direct link. Its mock-ups land on the same sign-off board, so one board holds the design questions and the retro's fixes.
- **Inside Firstmate:** opt in with `init --firstmate <home> --no-skill` (see `Firstmate` below). **Outside it:** nothing changes; there is no private-marker auto-detection.

## Runners and user-chosen models

Set `agent` (worker), `judge_agent` and one `agent_config.<agent>.model` for each. The worker labels the records and proposes fixes; the judge checks the findings and the fixes. To run a cheap worker and a stronger judge, give them different models: two agents, or one agent with `judge_model`. There is **no default model catalog**, automatic model selection, or fallback to another installed agent. `agents` shows configured agents and resolved roles, not a recommendation of which installed agent to use. The judge may be the worker's agent, each call in a fresh session. `agent_config` holds one model per agent, so it then runs the worker's model unless you set `judge_model`, which the judge runs instead (`init --judge-model` writes it when the judge shares the worker's agent and the models differ). The tool picks no model: with neither, `init` and `retro` ask.

The current CLI runners are `claude`, `codex`, `opencode` and `pi`. Claude, OpenCode and Pi run with tools off; Codex uses read-only mode. Each needs its own executable and login. `gemini` and `acp:<target>` (through `acpx`) have adapters, but are **not offered for retro roles**: their headless tool restrictions are not confirmed. `agents --test <runner>` can probe an adapter, including an unconfirmed one; it does not remove that restriction.

`byokit:<route>` calls a model without an agent CLI and has no tools. It requires Node **22.18+**, the BYOKit packages (dependencies of the tool, installed with it) and a ready plan route with its own sign-in or plan key. Routes include `byokit:chatgpt` and `byokit:claude`; other plan-key aliases depend on installed BYOKit support. Follow `doctor`'s readiness fixes; a route name alone is not a login or model choice.

Example shape, with placeholders to replace with your own choices:

```yaml
agent: "<worker-agent>"
judge_agent: "<judge-agent>"
agent_config:
  "<worker-agent>":
    model: "<user-chosen-model>"
    effort: low
  "<judge-agent>":
    model: "<user-chosen-model>"
judge_model: "<optional-stronger-model>"   # the judge's model when it differs from its agent's model above
agent_timeout: "20m"
```

Use the model id accepted by your runner; OpenCode requires `<provider>/<model>`. A project config can override these choices. Binary paths and extra argv overrides belong only in `$LFM_HOME/config.yaml` (`agent_path_override`, `agent_args_override`, `acpx_path`). A cloned project cannot set those overrides. Every model you set runs: no model name is blocked.

## Cost and limits

The CLI has no per-retro fee, but the agents or BYOKit use **your** subscription or paid provider. Cost depends on your chosen models, record volume, retries and plan. No fixed price or hosted-model quality is promised.

- `init`, ordinary `doctor`, `status` and `report` make no model calls. Login/version checks may run an agent's own status command.
- `retro`, `rerun` and `apply` can call models. `agents --test <runner>` makes a live probe; `doctor --live` probes both roles. These cost tokens.
- Defaults: `agent_timeout: "20m"` per attempt; `caps: { invocations: 14, bundle_chars: 60000 }`. A runner call can retry transient failures, up to three attempts. These are operational limits, **not a currency budget**.
- Reduce the configured sources or `window` (default `7d`) to bound the work. Inspect the report's not-checked section for capped or unread evidence.

## Follow a run and recover

```sh
learn-from-mistakes-axi attach                 # follow until the saved run ends
learn-from-mistakes-axi status --run 1          # inspect a particular saved run
learn-from-mistakes-axi logs --step analyse    # inspect why analysis failed
learn-from-mistakes-axi runs                   # recent saved runs
learn-from-mistakes-axi abort                  # cancel the current worker
learn-from-mistakes-axi rerun --resume --wait 8m
```

Use the run id from your output, not necessarily `1`. `rerun --resume` continues a failed, cancelled or interrupted run at its first incomplete step. Such a run kept no verdict, label, finding or fix, so the resume runs again from its `followup` step. A run saved by an earlier version whose steps ran in another order takes today's order (`analyse`, `verify`, `propose`, `verify-fixes`, `check`) and runs again from its first step that moved. A run whose done-done records keep ids from before the salt fails at its bundle step, because its bundle would name the app; its `next:` line starts a fresh `retro`. Plain `rerun` starts a new run with current config. `retro --foreground` runs in the calling process instead of detaching. Never combine `--foreground` with `--wait`.

`status`, the bare command and `retro --wait` exit **1** when the run they show failed or was interrupted or cancelled, and **0** for a completed or running run. Inspect `run.status` and the printed `next:`. A failed worker, unreadable source or unavailable judge is a problem to fix, not a reason to switch agents silently or to run without one.

## Sources, state and privacy

A `github` source also reads the repo's GitHub Actions runs through `gh api` (read-only). The report's numbers then include `ci_runs`, `ci_failure_rate` (finished runs that failed, as a share), `ci_reruns`, `ci_flaky_jobs` (failed, then passed on a rerun of the same run), `rework_per_merge`, `ci_failure_rate:<repo>`, and `ci_job_failures:<repo / workflow / job>` for each job that failed in either window. Each shows its value for this window and the last. The report lists the worst failing jobs by name. When the runs cannot be read, the PR numbers stay and the report's "Not checked" section names the missing runs and why. Job names are read for the newest 200 failed or rerun runs; GitHub lists at most 1000 runs a search.

Supported source types are `markdown-log`, `no-mistakes`, `sessions`, `github`, `done-done` and opt-in `firstmate`. Source records are read-only. A sessions source supports explicitly named `claude`, `codex`, `opencode`, `pi` and `gemini` stores for this project; it excludes the retro's own marked invocations. A cause's `match` names the source whose records it counts and narrows them with `signal`, `tool` and `text_contains` (sessions) or `error_contains`; when several rules fit one record, the most specific rule wins — a rule naming `tool` or `text_contains` beats one naming only `signal` — and among equals the earlier rule in the config stays.

A pipe hides its own test failure: the shell reports the last command in the pipe, so `npm test | tail -5` exits 0 with red tests and no error flag. A session reader then counts the tool result as `test_fail` from the output when the output's own summary line shows failed tests: node --test (`ℹ fail N` / `# fail N`), jest (`Tests: N failed`), vitest (`Tests  N failed`) or pytest (`N failed` in its `=====` summary line), with N above zero, and the bundle marks such an event `from output`. What stays invisible: other runners, and output cut before the summary line, for example `npm test | head`.

State normally lives in `.lfm/` beside the project config: `lfm.sqlite`, collected records, bundles, step logs and `runs/<id>/report.txt`. The tool writes `.lfm/.gitignore` containing `*`. An existing ignore file is never overwritten; it must contain `*` and no line starting with `!`, or state writes stop. Treat state as private. Git ignore is not encryption or access control. To put it elsewhere, set global `state_root`; each project then uses `<state_root>/<name>`.

**Excerpts are on by default.** The worker and judge providers receive redacted record excerpts in their bundle. Use `init --no-excerpts --no-skill` on a new config, or edit `excerpts: off` in an existing one, to send pointers and counts without record excerpts. This reduces the evidence available to analysis; it is not an offline mode.

Redaction covers recognized API keys, tokens, Slack incoming-webhook URLs (including their secret paths), URL passwords, private keys, Bearer/Basic/Token credentials (including repeated scheme words), secret-named assignments and email addresses. It is not a guarantee that all sensitive content is recognized. Do not point a hosted model at material you cannot share. Agent CLIs may retain their own sessions; this tool cannot promise provider-side deletion.

`report`, `retro` and `status` output ids, counts, metrics and verdicts, not finding prose or record text. `report --json` uses `lfm-report.v2`; `--full` adds allow-listed non-content evidence ids, not private text. The `report_txt` path points to the human-readable report; the file's text is never embedded in the JSON. Read `report.txt` privately before sharing it. Step logs, bundles and the database can hold sensitive material too.

Two explicit commands expose text beyond this compact projection: `changes` exports owner-written `what`/`why`; `signoff post` sends proposed-change text to the optional peer (without one it prints one `kept: <key>` line per fix the run did not apply, names fixes the run applied as applied, and points to `report.txt`). Diagnostics can name config files and state paths. Do not treat every command's stdout as a public report.

## Optional integrations and changes

### Firstmate

Opt in with `learn-from-mistakes-axi init --firstmate <home> --no-skill`, or add a `type: firstmate` source. There is no private-marker auto-detection and no dependency on Firstmate to run a retro.

The source reads `state/*.status`, inbox `*.msg` files including `handled/`, `data/defects.md`, `data/metrics/prs.tsv`, `data/metrics/daily.tsv`, `data/chat.tsv` and `config/targets.tsv`. Status lines use `<state> [at=<epoch>]: <text>`; messages use an `at=<epoch>` line and bracketed tag, or, with no such line, the epoch their file name starts with (`<epoch>-<id>.msg`). Without a github source, `prs.tsv` (one merged PR a row) gives `merged`, `first_pass`, the hours to merge, the rework counts, `reverted` and `escaped`; `daily.tsv` (`day`, `steers`, `s_correct` columns) gives `steers`, ahead of the inbox messages, and `corrections_per_merge` (corrections per merged PR), which also fills `corrections_per_session` when no sessions source gives it. `rework_per_merge` is the rework commits a merged PR. `chat.tsv` holds the captain's chat lines (header `at`, `work`, `text`; `at` is an epoch, `work` the task or PR the line points at). A line with the word why, wrong or again is a captain complaint: a mistake record with its text, date and work (the bundle says "about <work>"), counted in `defects` and listed with the unlabelled defect records; other lines are ignored. A table that is missing or has no rows is named in the report's "Not checked" section. A file or entry that vanishes while the state folder is read is skipped; any other read error names the path. Targets use tab-separated `metric op target owner rule`. The source also times where each task's hours go. A status line opens a stage that lasts until the next line's stamp: `working` and `resolved` lines are work, `queued` lines are queue time, `needs-decision` lines wait for the captain, and a `paused` or `blocked` line waits for CI, review, a merge or something else, named by its text. A task's last line, a line with no stamp and a line stamped before the one above add no time. The metrics `hours_working`, `hours_queued`, `hours_waiting_captain`, `hours_waiting_ci`, `hours_in_review`, `hours_blocked`, `hours_merge_wait` and `tasks_timed` give the hours each stage took in the window; the merge wait is the hours the merged PRs of `prs.tsv` stayed open, or the merge waits in the status lines when the home keeps no table. `report.txt` ranks the three longest waits with their cause and a ways-of-working fix. The reader writes nothing into that home. It can measure decisions, blocks, steers and interventions per merge when a GitHub source supplies merges.

To read a whole fleet in one retro, opt in with `init --firstmate <main-home> --fleet --no-skill`, or add `fleet: true` to the source. The source then reads the main home and each secondmate home that the main home's `data/secondmates.md` lists, one `- <id> - <summary> (home: <absolute path>; ...)` line each, so repeated causes count across homes. The `home:` and `host:` keys may come in any order, and a leading `~` expands. A line with a `host:` key (a remote route), or with no absolute home, is skipped and counted under "Not checked" in `report.txt`. A home path may not contain `;` or `)`: the value is cut at the first of either. A main home with no `data/secondmates.md` is a fleet of one. Each home is read by one source only: a home that two sources, or one registry, name fails the config, and the `next:` line names the sources, or the registry line for a home the registry lists twice. The main home's `config/targets.tsv` sets the targets. A listed home whose folder is missing fails the retro; the retro's `next:` line names the source, and `doctor` names the registry line to fix. A listed home whose folder exists but has no `state/` yet reads as empty. Each record keeps its home as a salted id: the bundle and every agent prompt carry that id, never a home name or path, and `report.txt` gives each home's decisions, blocks, steers and defects next to the fleet totals. The run store keeps the real paths.

### Sign-off

No peer is needed: questions stay in section 7 of `report.txt`. `doctor` warns if `sign-off-axi` is absent; `signoff: off` keeps that check quiet. A retro does not post automatically.

Only when you want a handoff, run:

```sh
learn-from-mistakes-axi signoff post
learn-from-mistakes-axi signoff answers
```

`post` sends the completed run's kept fixes as finding messages with Apply/Skip choices; a fix the run applied itself is printed as applied, never asked. Without the binary it prints one `kept: <key>` line per fix, the install hint and the `report.txt` path; nothing was posted and the fix text stays in `report.txt`. `answers` saves received answers, or reports no peer/no new answers. It applies nothing. Setting `signoff: off` does not disable a command you explicitly run.

### Apply only when requested

Default `auto_fix: 0` proposes only. `apply` commits kept fixes answered Apply (or a particular `--fix <n>`) on separate `lfm/<project>-<hash>/<run>-<n>` branches. It refuses a dirty tree, does not change your current branch/index/worktree, and never pushes or merges. Global `auto_fix: <n>` explicitly enables applying the top n kept fixes during retro, except those answered Skip. The run applies them before it writes `report.txt`, which names each one's branch, commit and ledger id and asks only about the rest.

To track a change you made yourself, use `change applied --cause <configured-cause> --ref <commit>`; `--proposal <run>:<n>` can identify a kept fix instead. Optional `--metric`, `--tripwire`, `--kind`, `--what` and `--why` record how to evaluate it. `changes --json` exports `lfm-changes.v1`; the next retro measures follow-ups. See `--help` for accepted values.

## Exit codes and automation

| Code | Meaning and next step |
| --- | --- |
| `0` | Command succeeded, or a background run started/is still running. Inspect status before claiming completion. Doctor warnings do not fail it. |
| `1` | Failed or interrupted run shown by `retro --wait`, `status`, the bare command, `attach` or `rerun`; agent/live-probe/input problem, invalid change ledger, or a doctor `fail`. Read diagnostics and the `fix:` / `next:` line. |
| `2` | Bad command/config, `abort` with nothing running, missing agent or model choice without a terminal, busy state, or another active retro. Follow the named correction; never choose on the user's behalf. |
| `3` | No saved run to inspect, no completed retro to report, or no run with kept fixes to `apply`. Start or finish a retro first. |

Use `--json` for structured output where supported; default output is compact TOON. A bare `learn-from-mistakes-axi` shows the latest run's status. `report` selects the latest completed retro, which may be older than the latest failed/running run. Check its `run` id. `--dir <project>` targets another project without changing directories. `guide` gives the current calling-agent procedure; `--help` is the installed version's command reference.

## Development

```sh
npm ci
npm test
npm run build:skill -- --check
```

The README, `skills/` and `docs/` (icon, shots, landing page) ship with the code: a change that makes one of them stale updates it in the same PR. CI (`.github/workflows/ci.yml`) runs the full suite on every PR and skips it for docs-only changes.

`.done-done.yaml` defines the existing `cli` and `package` verification journeys. `scripts/verify-journeys.mjs` drives synthetic CLI/process-boundary checks, including the README setup-to-report path; `--package` also installs and exercises the packed CLI. Synthetic agent replies prove orchestration, not hosted-model quality. Keep evidence outside the checkout.
