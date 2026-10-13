<p align="center"><img src="docs/logo.svg" width="96" height="96" alt="learn-from-mistakes logo"></p>

<h1 align="center">learn-from-mistakes</h1>

<p align="center">Find the mistakes your coding agents keep repeating, with the evidence for each, and a short list of changes to stop them.</p>

`learn-from-mistakes-axi` is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup (`npx -y learn-from-mistakes-axi`).
- It's built for agents: TOON output by default, `--json` and `--full` when asked, a contextual `next:` hint that names the likely next command, and the bare command does the main job (the report).
- The skill below only handles discovery; agents learn the tool by using it.

## Quick Start

Install the skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx -y skills add umeranjum17/learn-from-mistakes --skill learn-from-mistakes -g -a claude-code -y
```

That is the entire setup - no npm install needed.
`-a` names your agent (`claude-code`, `codex` or `opencode`; repeat it for several) and `-y` skips the installer's questions.
The skill teaches your agent to run the tool through `npx -y learn-from-mistakes-axi`, so the CLI comes along on demand.
It stays a short stub and sends the agent to `npx -y learn-from-mistakes-axi --help` and `guide` for the current procedure, so an installed copy cannot go stale against a newer CLI.
Its frontmatter also includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/learn-from-mistakes what keeps going wrong here?
```

Or just ask in plain words - "what keeps going wrong in this project? the log is defects.md", or "Start a retro and show me the report." - and the agent loads the skill on its own when it recognizes the task.
It writes `.learn-from-mistakes.yaml` if the project has none and starts a retro. The tool runs its own agent to label the records: the worker, the `agent` you set with its `agent_config` model (`agent: <agent>` with `agent_config: { <agent>: { model: <model> } }`). Set your agents in the config; the run never picks one. Your agent only starts the retro and reads the result: the repeated causes with counts.
A retro whose `agent` or `judge_agent`, or its model, is not set stops before it starts with the ask line (exit 2); one whose worker is not ready stops at `analyse` (exit 1): ask the user which agent and model to use, then set the key it names in the config file it names.
The report's `--json` output carries only ids, counts and each finding's judge verdict word. The default and `--full` reports also print one redacted `finding:` summary line per finding of the counted run. The recommended changes are in `proposals.jsonl` in the state dir, or ask your agent to summarise them.

`-g` installs the skill for all projects (`~/.claude/skills/`, for example); drop it to install into the current project only.

## Other Ways to Use It

### Zero setup

Any capable agent can run the CLI directly with nothing installed at all. Just tell your agent:

```
Run `npx -y learn-from-mistakes-axi --help` and tell me what keeps going wrong in this project.
```

### With Firstmate

Nothing in Firstmate changes; the tool only reads its records.

1. Install the skill into the Firstmate home (the clone). In the home, without `-g`:

   ```sh
   npx -y skills add umeranjum17/learn-from-mistakes --skill learn-from-mistakes -a <agent> -y
   ```

   `-a codex` or `-a opencode` puts it in the home's `.agents/skills`; `-a claude-code` puts it in `.claude/skills`. Or keep `-g` for every project.
2. Put `.learn-from-mistakes.yaml` in the home root. The log source is your defect log, for example `data/defects.md`; the no-mistakes store is optional:

   ```yaml
   name: firstmate
   sources:
     log: { type: markdown-log, path: data/defects.md }
     # gate: { type: no-mistakes, path: ~/.no-mistakes/state.sqlite }   # optional: no-mistakes store
   ```

3. Ask your agent: "Use the learn-from-mistakes skill to label data/defects.md, propose causes, then show the report."

### Manual CLI

Needs Node 22.13 or newer (22.18 or newer for `byokit:<route>`, see [Command line](#command-line)). To install from a checkout:

```sh
git clone https://github.com/umeranjum17/learn-from-mistakes
cd learn-from-mistakes && npm install && npm link   # puts learn-from-mistakes-axi on your PATH
```

1. Run `learn-from-mistakes-axi init` in your project. It writes `.learn-from-mistakes.yaml` if the project has none (otherwise it prints `already set up` and any gaps), with the agents and models you choose (`--agent`/`--model` and `--judge-agent`/`--judge-model`, or a pick in a terminal), the sources it detects (a defect log, `reviews.md`, a no-mistakes store, agent sessions, GitHub PRs), 4 starter causes (only into a project file it creates, an existing file is never rewritten: its gaps say how to add causes; edit them), and excerpts on (`--no-excerpts` writes them off). With no agent chosen and no terminal it prints what it wrote, then exits 2 with the ask line; `init -y` writes the files without agents. Or write the file yourself:

   ```yaml
   name: my-project
   sources:
     log: { type: markdown-log, path: defects.md }   # each "- " bullet is a record; a YYYY-MM-DD in it dates it, else its "## 2026-03-02" heading
     # gate: { type: no-mistakes, path: ~/.no-mistakes/state.sqlite }   # optional: no-mistakes store, this repo's failed steps read-only
     # sessions: { type: sessions }   # optional, one per config: this repo's Claude Code, Codex and OpenCode sessions, read-only
     # prs: { type: github }   # optional: the PRs of origin's GitHub repo, read-only through your own gh login
     # proof: { type: done-done, apps: [my-app] }   # optional: done-done's failed verify run steps, read-only
   causes:
     agent-exit-wait:
       description: A pipeline step fails because the agent's output pipe stays open.
       # match: { source: gate, error_contains: "wait delay expired" }  # optional: no-mistakes store, counts typed rows
       # match: { source: sessions, signal: test_fail, tool: Bash, text_contains: "FIXTURES" }  # or a sessions source: any of signal, tool, text_contains
   repeat: { min_incidents: 3, min_days: 2 }
   # signoff: off   # optional, auto (default) or off: off makes doctor's sign-off check ok and keeps questions in report.txt; an explicit `signoff post` or `signoff answers` still runs, because you asked for it
   ```

2. Run `learn-from-mistakes-axi ingest --dir .`. It prints the state dir: `.lfm/` next to `.learn-from-mistakes.yaml`. The tool writes `.lfm/.gitignore` (`*`) whenever it writes state there and finds none, so the state is never committed and you edit no `.gitignore` of your own. An existing `.lfm/.gitignore` is never overwritten: it must contain the line `*` with no line starting with `!`, or the write exits 2 before any state is written. To keep state outside the project instead, set `state_root: <dir>` in `$LFM_HOME/config.yaml` (`LFM_HOME` defaults to `~/.learn-from-mistakes`); the state then goes to `<dir>/<name>`.
3. Ask your agent to start a retro (`learn-from-mistakes-axi retro --wait 15m`). The tool runs its own agent, the `agent` you set in the config, to label the records; the run never picks one. Your agent only starts it and reads the result. Without a retro, your agent can still follow `learn-from-mistakes-axi guide` and write `labels.jsonl` and `proposals.jsonl` in the state dir by hand.
4. Read the result. A finished retro prints it: the causes its labels counted and the worker's findings, one line each (`status` prints it again). A bare command, or `report`, prints the repeated causes from the last completed retro that has labels (`labels_from: run <id>`), with each finding's cause, its counts and its summary line; with no such run, or with `--labels <file>`, it counts `labels.jsonl`, the manual path. The recommended changes are in `proposals.jsonl` in the state dir, or ask your agent to summarise them.

## Why

Agent fleets write down what went wrong: a defect log, a pipeline's failed steps. The same cause turns up again and again, yet nobody counts it, so the fix never gets priority. Counting by keyword is wrong too: "database is locked" in one tool is not the same cause as in another.

`learn-from-mistakes-axi` splits the work. Your agent reads each record and judges what happened, following the CLI's own `guide`. The CLI does the arithmetic: it merges duplicates, counts each source separately, checks that every recommendation cites real records, and lists what was never read.

## Command line

```
learn-from-mistakes-axi           print the project's repeated-cause report (same as `report`)
learn-from-mistakes-axi init [--agent <agent> [--model <model>]] [--judge-agent <agent> [--judge-model <model>]] [--no-excerpts] [-y]   write ~/.learn-from-mistakes/config.yaml and .learn-from-mistakes.yaml, each once, with the sources found; save the agents the user chose (in a terminal, with none given, it asks), and check that the worker and a different judge resolve
learn-from-mistakes-axi doctor [--live]   one ok/warn/fail line per check (node, git, config, .lfm ignored, each source, worker and judge: usable, login, model, a different identity; the skill per agent CLI; sign-off) with a fix: line under each that is not ok; --live makes one agents --test call per role (costs tokens); --json prints JSON
learn-from-mistakes-axi guide     print the agent procedure: config, ingest, label, propose, report
learn-from-mistakes-axi ingest    read the configured sources (read-only) into the state dir
learn-from-mistakes-axi count     print the counts (same projection as `report`)
learn-from-mistakes-axi report    print the report: the last retro's labels, else labels.jsonl; --full adds evidence ids, --json prints JSON
learn-from-mistakes-axi change applied (--cause <cause> | --proposal <run>:<n>) --ref <ref> [--metric <metric>] [--tripwire "<op> <number>"] [--kind doc|rule|code] [--at <time>] [--what <text>] [--why <text>]   record an applied change in the ledger
learn-from-mistakes-axi changes   print every applied change (lfm-changes.v1) with its what and why
learn-from-mistakes-axi signoff post [--run <id>]   post the latest completed run's kept fixes to sign-off as `finding` messages, only when you ask; without sign-off-axi it prints them and `npm i -g sign-off-axi`
learn-from-mistakes-axi signoff answers   save each Apply/Skip answer to a posted finding (read once with `sign-off-axi wait`); a change is never applied for you
learn-from-mistakes-axi retro [--wait [<time>] | --foreground]   ingest, label with the tool's own agent and report as one saved run, in a background worker
learn-from-mistakes-axi status    print the last saved run and its steps (--run <id> for another)
learn-from-mistakes-axi runs      list the saved runs, newest first (the last 10)
learn-from-mistakes-axi attach    follow the run: its step lines and states as they come, until it ends
learn-from-mistakes-axi logs --step <name>   print one step's log (--run <id> for another run)
learn-from-mistakes-axi abort     stop the running run; it ends as cancelled
learn-from-mistakes-axi rerun [--resume] [--run <id>] [--wait <time>]   start a new run with the current config (default: follows the last run); --run <id> names the run it follows; --resume finishes that run from its first step that is not completed
learn-from-mistakes-axi agents    list the configured agents: usable, version, login presence, model, and the resolved worker and judge
learn-from-mistakes-axi agents --test <runner>   one live call to that agent CLI, `acp:<target>` through acpx, or `byokit:<route>` through BYOKit (costs tokens): it must answer and write no file
learn-from-mistakes-axi --help    show the commands and options
learn-from-mistakes-axi --version show the version
```

Every command stays useful:

- Default output is **TOON** (compact, token-lean). For `report`/`count`, `--json` prints the same data as JSON under the versioned `lfm-report.v1` schema (`changes --json` is `lfm-changes.v1`, below). `generated_at` is when the report ran; `ingested_at` is when `ingest` last read the sources. The added field keeps the schema at `lfm-report.v1`.
- `--full` adds allow-listed evidence **ids** — non-content source row ids only, never a content-derived record id or record text.
- `change applied` appends one versioned entry (`chg-<n>`, cause key, version id, time) to the append-only `<state dir>/changes.jsonl` ledger, and the report then shows per cause how many applied changes exist (`changes: { count, last_at }`, top-level `ledger: { entries }`; `--full` adds `change_ids`/`change_refs`). `<cause>` must be a cause key from the config (`other` is never recordable); `<ref>` is a git sha (7-40 hex) or `sha256:<64 hex>`; `--at` defaults to now. `--metric`, `--tripwire` and `--kind` record what will show whether the change worked: the metric to watch (a metric name, or `cause_count:<cause>` for any configured cause; default `cause_count:<cause>` of the change's own cause), the value it must reach (`"<op> <number>"` with `>=`, `<=`, `>`, `<` or `=`, as a target; default none) and what the change edited (`doc`, `rule` or `code`; default `doc`). A bad value exits 2 and names the allowed form. A ledger line written before these fields reads as the defaults. `--proposal <run>:<n>` records that run's kept fix `n` (the `fixes` that `status --run <run>` lists) in place of `--cause`: its cause, metric and tripwire go into the entry, and `--metric` or `--tripwire` override them; a fix the check step did not keep has no number and exits 2. `--what` and `--why` are optional owner-written text, one line of 1-200 characters each (trimmed; a newline or control character is rejected); the report never prints them.
- `changes` prints every ledger entry in ledger order under the `lfm-changes.v1` schema (TOON by default, `--json` for JSON). It needs only the config, not `ingest`.
- `retro` saves a run in `<state dir>/lfm.sqlite`: a `runs` row with its status and the pid of the process that runs it, and one `steps` row each for `collect` (ingest), `metrics` (the numbers, below), `followup` (did each applied change work, below), `bundle` (the file the run's agents read, below), `analyse` (the worker labels the records, below), `propose` (the worker's fixes, below), `verify` (the judge's verdict on each finding and fix, below), `check` (the rules the fixes must follow, below) and `report` (the counts with the worker's labels from this run, else with the labels already in the state dir). A detached worker runs the steps, so the run goes on when the terminal or the calling agent ends; `retro` returns at once, `--wait 8m` waits up to that time and prints the outcome (a bare `--wait` waits 8 minutes); a completed run adds `result`: its labelled and record counts, each counted cause with its incidents, days and store rows, and each worker finding as its cause, its count, days and the judge's verdict (or `not judged`), and its summary. A run whose worker labelled nothing and found nothing says so on stderr, with `next:` the analyse log, and `--foreground` runs the steps in the same process. One run runs at a time: a second `retro` exits 2 and names the running run. A failed step fails the run and exits 1; `status` and `runs` show the saved runs, and `status` exits 3 before the first one.
- A run whose worker stopped without ending it (a crash or a kill) shows as `interrupted` in `status` and `runs`, and no longer blocks a new `retro`. `rerun --resume [--run <id>]` runs an interrupted, cancelled or failed run again from its first step that is not completed; completed steps keep their output and do not run again. A SIGTERM or SIGINT to the worker ends the run as `cancelled`.
- `attach` prints each step's state changes and log lines as they come and exits when the run ends (0 when it completed). Each step's log is `<state dir>/runs/<id>/<step>.log`, holding its latest attempt; a step that has not started in its run has no lines. `logs --step collect` prints one. `abort` sends SIGTERM to the run's worker (SIGKILL after 3 s) and marks the run `cancelled`. A plain `rerun --run <id>` starts a new run with the current config, names run `<id>` in its output, and leaves run `<id>` as it was; `rerun --resume --run <id>` is the one that finishes run `<id>`.
- `agents` lists the configured agents (`agent` and `judge_agent`; never the others installed, so it offers none to pick from) among those the tool can start as its own workers (claude, codex, opencode, pi, gemini, and any ACP agent as `acp:<target>` through `acpx`): usable (found on an absolute PATH entry, and `--version` exits 0; relative PATH entries are skipped), version, tools (`off`, `read-only`, or `unconfirmed` for acp), login presence (file and variable names only, never their contents) and the model, `agent_config.<agent>.model`. A runner whose tool-off mode is not confirmed is listed with `not offered:` and the reason, and is never picked as worker or judge: gemini (its read-only `--approval-mode plan` is not yet confirmed in headless mode) and acp (`acpx --deny-all` only denies the permission requests an agent sends; pi and opencode run their tools without asking). It adds the resolved `worker` and `judge`; a judge that resolves to the worker's binary and model exits 1 with the fix. With no model set, `--test` and `doctor --live` are refused: an empty model never makes a call. `allow_premium: true` only permits a premium model name. `agents --test <runner>` (or `--test acp:<target>`, in `runs/test-acp-<target>/`) makes one live call in `<state dir>/runs/test-<runner>/` with tools off (Codex and Gemini: read-only) and no saved session, except OpenCode and Gemini, which keep theirs; it works on a runner that is not offered, to check it: it asks the agent to write `x.txt` and exits 1 if any file appears, if an attempt gets no answer within `agent_timeout` (each attempt has its own; a call makes at most 3 attempts), or with the agent's own error; a plain-text answer passes and prints as the reply.
- The `collect` step also reads a `sessions` source: the Claude Code, Codex and OpenCode sessions run in this repo, a subdir or one of its git worktrees (`agents: [auto]`, or a list of `claude`, `codex`, `opencode`), from `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`, the threads `${CODEX_HOME:-~/.codex}/state_5.sqlite` lists, and every OpenCode database in `${XDG_DATA_HOME:-~/.local/share}/opencode` (each opened read-only; the tool never writes to a store), changed since the start of this window and the last (`window`, default `7d`), or earlier when an applied change needs before-numbers. It skips the tool's own agent runs and any session file it cannot read (counted in `skipped`). It saves one `events` row per session start, user message, tool call, tool result, correction and interrupt. Its run output carries each sessions source's `sessions` and `skipped`.
- The `collect` step also reads a `proof` source of type `done-done`: for each app named, the failed, inconclusive or overridden verify runs in done-done's run store (`~/.done-done`, or `$DONE_DONE_HOME`; `path:` sets it), read-only. Each failed step of such a run is a `records` row with its reason (redacted) and the run file as its ref; passed and cancelled runs make no records. With no done-done installed nothing changes. Its record rules and failure modes are in the verify skill's `features/done-done.md`.
- The `collect` step also reads a `github` source: the pull requests merged since the start of the read range in the GitHub repo that the project's git `origin` names, through your own `gh` (`gh api graphql`, read-only; `gh auth login` first). It saves one `records` row per PR, with its title and body (redacted as below; none with `excerpts: off`) and the facts its numbers count. One project takes one github source. A missing or logged-out `gh`, a failed query or an origin that is not on GitHub exits 2 with the fix; the origin URL is never printed. `init` adds the source when `origin` is on GitHub and `gh auth status` passes.
- The `metrics` step saves the numbers for this window (`current`, from `window.current_start` on) and the last one (`previous`, the same length before it) in the store's `metrics` table, and the run output lists them (`metrics[]{name,current,previous,target,met}`). A metric with a `targets:` entry (defaults: `first_pass: ">= 70"`, `p90_hours_to_merge: "<= 8"`, `tool_error_rate: "<= 0.05"`, `corrections_per_session: "<= 0.3"`, `escaped: "<= 0"`) shows its target and whether this window `met` or `missed` it; an `n/a` number is neither, so it shows `n/a`, and a metric with no target shows both empty. The store keeps each window's `target` (NULL with none), so a later config change does not rewrite past runs; `met` or `missed` is computed from the unrounded stored value when the run is shown. Each source gives its own: a sessions source `tool_error_rate`, `corrections_per_session`, `interrupts` and `retries` over the events in the window; a defect log `defects`, its records dated in the window (a `reviews` log is not counted); a github source, over the PRs merged in the window, `merged`, `first_pass` (the percent of PRs by people, not bots, with no commit authored after the PR opened, not reverted and not escaped), `p50_hours_to_merge` and `p90_hours_to_merge` (open to merge), `rework_ci` and `rework_other` (commits after open, by whether the commit before had failing checks; base-branch merge commits are not rework), `reverted` (a later merged PR whose title starts with `Revert`, `Reverts` or `Reverted` names `#N`) and `escaped` (a later merged PR whose title starts with `fix`, `fixes` or `fixed`, so `fix:` and `fix(scope):` too, names `#N`). A PR with more than 100 commits is read from its first 100. `cause_count:<cause>` counts the items a cause's `match` rule tagged in the window: gate rows whose error has `error_contains`, or session events with that `signal`, `tool` and `text_contains`. Each row takes one cause, the first matching rule in config order. `text_contains` matches the text of signal events only: failed tool results (tool errors, non-zero exits, failed tests), retries and corrections. A retry is matched on its call's input values as plain text (for Bash, the command). A successful call, its output or a plain message is never checked, so the rule matches nothing there. A rule tags signal events only, so `tool: Bash` alone tags failed Bash results and retries, never a successful call. The text is read whole, so it works with `excerpts: off`. Defect logs sum into one `defects`. A number with nothing to count is `n/a` (NULL in the store), never 0: a metric whose source type is not configured, a target no source measures, a cause with no `match` rule, session numbers with no session in the window, a defect log with no dates.
- The `followup` step checks whether each applied change in the ledger worked. It computes the change's metric before the change (over one `window` up to it) and after it (from the change to the run), from what `collect` read, which reaches back far enough for the earliest change. It saves one `followups` row per change in the store (`before`, `after`, `tripwire`, `verdict`; NULL for an `n/a` number or no tripwire), and the run output lists them (`followups[]{change,metric,before,after,tripwire,verdict}`). The verdict comes from code, by the first rule that fits: `no-data` when the after range has fewer than `followup.min_sessions` sessions (default 3) or `followup.min_days` days (default 2), or the metric is `n/a` before or after, or a records-based metric (a cause whose match rule names a no-mistakes source, or `defects`) has no record on or before the start of the before window, or a change added after `collect` read the ledger has a before or after range that starts before what `collect` read (`read_from`); `keep` when the after number meets the tripwire; `delete` for a `--kind rule` change whose metric moved less than 10% of its before number (or stayed 0) in this retro and the last, with or without a tripwire it misses; `no-data` when the change has no tripwire; `rollback` when it misses and the number did not improve (lower for `<`/`<=`, higher for `>`/`>=`, nearer for `=`), or it missed in the last retro too; `fix` when it improved but missed. "The last retro" is the change's row in the latest earlier run that measured it whose read time is at least `followup.min_days` before this run's (a rerun over the same data is not a second retro; a run that failed or was cancelled before its `followup` step has none); when that run had too few sessions or days after the change, or an `n/a` number, there is no last retro. The fleet sources have no rollback threshold, so these rules are this tool's own. Session counts come from a `sessions` source, so a project with none gets `no-data`.
- `byokit:<route>` as `agent` or `judge_agent`, or in `agents --test byokit:<route>`, sends a plain model call through BYOKit, with no agent CLI and no tools. `byokit:chatgpt` and `byokit:claude` use the ChatGPT or Claude plan you signed in to, read from this computer's BYOKit store (member `lfm`, sealed under the `byokit` seal service that every BYOKit app shares). A plan key route in BYOKit's route list, such as `byokit:opencode-go`, takes the key from the variable the route names (`OPENCODE_API_KEY`), holds it in memory for the call and never saves it. A route's model is `agent_config."byokit:<route>".model`, which the user sets; with none set, the route is refused. It never reads an agent CLI's login. It needs Node 22.18 or later and the optional `@byokit/accounts`, `@byokit/secrets` and `@earendil-works/pi-ai` packages (installed with the CLI unless optional packages are omitted). As a role, its identity is the route and model.
- A no-mistakes source reads only this repo's failed steps: the store's runs of a repo whose checkout is this project or one of its git worktrees, or whose upstream URL is its `origin`. A store with no `repos` table is not a no-mistakes store and exits 2.
- The `bundle` step writes `<state dir>/runs/<id>/bundle.md`, the one file the run's own agents read: the metrics table with each target, the follow-ups (none yet), the signal clusters (this window's session events with a failure signal, grouped by tool and signal, largest first, each with its 3 latest events) and the records no `match` rule tagged (this window's and the undated ones). Each item has an id (`[c1]` a cluster, `[e<n>]` an event's store row id, for reference only and not for labels, and a record's id, the one `labels.jsonl` takes: its records.jsonl id, or `<source>:<step id>` for a gate row, `<source>:<number>` for a PR), its refs (session id and `file:line`, or the record's `file:line` or `db:step_results:<id>`) and, with `excerpts: on`, an excerpt of at most 300 characters. Every string in it goes through the same redaction as the session excerpts, except a record id, which is printed as the store keeps it so the worker can cite it. With `excerpts: off` it holds pointers and counts only, never record or session text. Items that would pass `caps.bundle_chars` (at least 1000) are dropped, and its last line counts them; the step log gives the items, dropped items and characters.
- The `analyse` step gives `bundle.md` to the worker, the `agent` the user set (in the run dir, tools off) with the retro method: hunt hidden problems first, a shared keyword is not a shared cause, a consequence is not a repeat, label only what you read, the label rules of `guide`, and plain English (at most 20 words a sentence). The worker answers one JSON object: `findings` (a cause, a summary and refs to bundle ids) and `labels` (one per record, as `labels.jsonl` takes them). They go to the store's `findings` and `labels` tables, and the `report` step counts with these labels. A bad answer goes back once with the problems; a second one fails the step, and `logs --step analyse` shows why. A ref or label that names no bundle item is logged as a `problem:` and not kept. Each agent call is one `invocations` row (agent, model, process group, how it ended, session id and tokens when the agent reports them); a run makes at most `caps.invocations` calls (default 12). A bundle with nothing to cite asks no agent. A worker that is not set (`agent`) or does not resolve to a ready agent fails the step with one fix line that names the config file and `agent`; the run never picks an agent.
- The `propose` step gives the worker each cause with its incidents and days and whether it repeated, the findings it kept and each applied change whose follow-up verdict is not `keep`, then `bundle.md`. It asks for at most five fixes, each with a cause, a kind (`doc`, `rule` or `code`), a target, an owner, the change (at most 3 sentences), a metric, a tripwire and refs to bundle ids, and preferring a check, a script or a deleted rule over more prose, plus a reason (at most 25 words) for each of those follow-ups; the worker never sets a verdict. The fixes go to the store's `proposals` table and the reasons to `followups.reason`. A bad answer goes back once, as in `analyse`; on the second answer each proposal or reason that breaks a rule is dropped and logged as `dropped: ...`, and the valid ones are kept (only a top level that is not a `proposals` and `reasons` list fails the step). With no finding and no follow-up to explain it asks no agent.
- The `verify` step gives the judge, the `judge_agent` the user set (an agent and model that differ from the worker's), each finding and fix as a claim with its refs, then `bundle.md`. The worker's claims are not evidence: the judge checks each claim against the bundle items it cites and answers `confirmed`, `weakened` or `refuted`, with a reason (at most 25 words). The verdicts go to `verdict` and `judge_note` in the store's `findings` and `proposals` tables, and the step logs only the claim ids and verdicts. A bad answer goes back once, as in `analyse`; on the second answer each verdict that breaks a rule is dropped and logged, and a claim with no verdict stays not judged. With no finding and no fix it asks no agent.
- The `check` step keeps only the fixes that follow the rules: the cause has counted events and repeated (`repeat:` over the run's labels, the items a `match` rule tagged, or the items a finding cites), the refs name bundle items, and it has a target, an owner, a metric (default `cause_count:<cause>`) and a tripwire. A fix that breaks a rule is logged as a `problem:` with the rule and is not kept. The kept fixes are ranked by how often their cause came back, then by how far their metric misses its target, and numbered 1 to 5; a sixth is a problem. `status` lists the kept fixes as `fixes` (number, cause, metric, tripwire).
- Each working command ends with a `next:` hint on stderr (ingest also names the labelling step on stdout; `--help` and `guide` print theirs on stdout), so an agent can chain `ingest → report → --full → --json` without reading the docs.

Default TOON output, abridged to one cause on the example project:

```
schema: lfm-report.v1
generated_at: "2026-10-12T09:00:00.000Z"
ingested_at: "2026-10-12T08:00:00.000Z"
coverage:
  labelled: 13
  total_records: 13
  unlabelled: 0
problems: 0
sources[2]{id,type,items}:
  log,markdown-log,13
  gate,no-mistakes,5
causes[1]:
  - cause: server-memory-kill
    repeated: true
    by[1]: log
    log:
      incidents: 4
      records: 3
      days: 3
    store:
      matched: false
      rows: 0
      days: 0
    proposals:
      count: 2
      unchecked: 0
```

## For sign-off and other tools

`signoff post` and `signoff answers` are the only hand-off to sign-off, and only when you run them; the tool works the same without it (see [sign-off](https://github.com/umeranjum17/sign-off) for its contract).

`learn-from-mistakes-axi changes --json` is the machine contract for applied changes, so another tool can join its own results on a change (for example a "Helped? yes/no/unclear" sign-off, which this tool does not write; its followup verdicts are shown by `status`, not in this export):

```json
{
  "schema": "lfm-changes.v1",
  "generated_at": "2026-10-12T09:00:00.000Z",
  "project": "my-project",
  "changes": [
    { "id": "chg-1", "cause": "server-memory-kill", "ref": "abc1234", "at": "2026-10-11T08:00:00.000Z",
      "metric": "cause_count:server-memory-kill", "tripwire": "<= 0", "kind": "doc",
      "what": "Run builds in their own memory group", "why": "The memory killer stopped the server three times" }
  ]
}
```

- Join on `project` + `id`. `id` is `chg-<n>` from the append-only ledger: never reused or rewritten.
- `ref` is the accepted version (a git sha or `sha256:` of the changed file); `at` is when it was applied (ISO-8601).
- `metric`, `tripwire` and `kind` are the change's `--metric`, `--tripwire` and `--kind`, or their defaults (`cause_count:<cause>`, `""` for no tripwire, `doc`), also for an entry written before these fields.
- `what` and `why` are exactly the text the owner passed to `change applied`, or `""` when none was given.
- Pin `schema: lfm-changes.v1`. An invalid ledger exits 1 and names `file:line` only, with nothing on stdout.

## Privacy

The report's `--json` output is **privacy-bounded**: identifiers, counts and each finding's judge verdict word, never record text. The default (TOON) and `--full` reports also print one `finding:` line per finding of the counted run, with the worker's summary (redacted, one line); `status` and `retro` print the same summaries in `result`. It never prints record text, a label's `why`, a proposal's `change`, a change's `what`/`why`, cause descriptions, source paths, branches or error text, and never turns a record's text into an id. Two outputs print free text. `changes` prints only the `what`/`why` the owner wrote with `change applied` to be shared; it never carries record text, label or proposal prose. A finished run's `result` (`retro`, `status`, `attach`) prints each worker finding's summary: the run's own agent wrote it from the bundle (redacted excerpts, or none with `excerpts: off`), in at most 3 sentences with no ids; it never prints a label's `why`. That is why the default and `--full` report output can be logged, shared or handed to another tool without leaking the private records the counts came from. `--full` is not permission to print private evidence; it only adds non-content source row ids. Error diagnostics are the one exception: they may name a source by its config id (for example `source log: cannot read (ENOENT)`) rather than its path, and never echo record text.

The state dir is not bounded: `.lfm/records.jsonl` holds the redacted text of every record with `excerpts: on` (and no text field with `excerpts: off`), `lfm.sqlite`'s `records` table holds the same text for defect bullets, the redacted error of each failed gate step and the redacted title and body of each PR, and `labels.jsonl`/`proposals.jsonl` hold your agent's prose, as do a retro's worker `labels`, `findings` and `proposals` tables and its follow-up reasons in `lfm.sqlite`, and the `signoff` table keeps each message posted to sign-off (its proposed change). It stays in the project's `.lfm/`, which the tool git-ignores with its own `.lfm/.gitignore` (an existing one is never overwritten; it must contain the line `*` with no line starting with `!`, or `ingest`, `change applied` and `retro` exit 2 before writing any state), so none of it reaches a commit. Treat `.lfm/` as private as the sources it was read from. Each run's `bundle.md` holds redacted excerpts of those records and session events, or none with `excerpts: off`. With a `sessions` source, `lfm.sqlite` also keeps an excerpt of each session failure, retry and correction: at most 300 characters, with API keys, tokens, a password in a URL, private keys, Bearer and Basic credentials, `KEY=value`, `"key": "value"` and `--key value` secrets whose key name contains token, secret, password, key or auth, and email addresses, replaced by `[redacted]`; a wider key list comes in a later version. `excerpts: off` keeps none.

## Exit codes

| Code | Meaning | stderr |
| --- | --- | --- |
| `0` | ok | a `next:` hint |
| `1` | an input problem: a label, a proposal or the existing change ledger has a problem, including a line that is not valid JSON; for `agents`, and for a fresh `init`, a worker or judge problem; for `doctor`, any `fail` line; for `agents`, also a failed `--test` call | `error: <file>:<line>: not valid JSON`, or for the report one `problem: <file>:<line>: ...` line each (the line and the rule broken, never record text, a record id or a ref) and `problems: N`; then `next:` |
| `2` | bad usage or config: an unknown command or option, a flag the command does not take, a missing or invalid value, a bad `.learn-from-mistakes.yaml`, missing state | `error:` naming the flag or value (a value longer than 80 characters or with control characters shows as `(invalid value)`; file paths print whole, and a `--dir`/`--labels`/`--proposals` path with a control character is rejected), then `next:` with the allowed form or a runnable command, never the whole usage |
| `3` | the sources hold nothing | `next: learn-from-mistakes-axi ingest` |

A rejected `change applied` never touches the ledger. A missing prerequisite or empty source prints an actionable `next:` command; it never invents events.

## Model

The label/propose reading is agent work: the tool's own agent does it on the model the user set. The user chooses the models; never switch to Opus, Sonnet or Sol yourself.
Every retro starts the tool's own agents, a worker and a judge. You set them: the tool never picks an agent or a model. They are set in `$LFM_HOME/config.yaml` (default `~/.learn-from-mistakes/config.yaml`), which `init` writes once, fully commented, or in a project's `.learn-from-mistakes.yaml`; this is the same config shape as no-mistakes. For example:

```yaml
# Agent that runs the retro's agent steps: one agent, and the tool never tries another when it is not ready.
# Options: claude, codex, opencode, pi, acp:<target>, byokit:<route>
agent: "<agent>"
# Agent that checks the worker's output: another agent than the worker.
judge_agent: "<judge agent>"
# Model and effort (minimal, low, medium, high, xhigh, max) per agent.
agent_config:
  "<agent>":
    model: "<model>"
    effort: low
  "<judge agent>":
    model: "<model>"
# Maximum wall-clock time for one agent call.
agent_timeout: "20m"
# allow_premium: false
# agent_path_override: { claude: /usr/local/bin/claude }   # global only
# agent_args_override: { codex: [-c, service_tier="priority"] }   # global only
# acpx_path: acpx   # global only
# state_root: ~/.learn-from-mistakes/state   # global only
```

When `agent` or `judge_agent` is not set, or the agent it names has no `agent_config.<agent>.model`, `init`, `retro`, `rerun`, `doctor` and `agents` ask: in a terminal, a pick list of the supported agents (only when the agent is not set) and then the model, saved to the config file; otherwise (an agent calling the CLI) they exit 2 with `ask the user which agent to use`, the choices, and `next: learn-from-mistakes-axi init --agent <agent> --model <model> --judge-agent <agent> --judge-model <model>` to save the user's answer; then run the stopped command again. `init -y` asks nothing. `agent` and `judge_agent` each take one agent: a list is refused, and a set agent that is not ready stops with its own fix, never another agent. A judge is never the worker's agent and model, and `agent_config` holds one model per agent, so the judge is always another agent. A project's `.learn-from-mistakes.yaml` may override `agent`, `judge_agent`, `agent_config`, `agent_timeout` and `allow_premium`; the other keys are global only, so a cloned repo never picks the binary an agent runs or its flags. A premium model (a name with `opus`, `sonnet` or `sol` as a separate word in it) is refused by every call that would use it, retro, `agents --test` and `doctor --live` alike, unless `allow_premium: true`.

## What it does not do

`learn-from-mistakes-axi` never edits your sources or instructions, writes only its own config (`init`, once) and state dir (and `signoff post` hands messages to the sign-off board only when you run it), and makes no network or model calls itself; only the runs, `agents --test` and `doctor --live` start your own agent CLI, which calls its model, or, for `byokit:<route>`, a BYOKit model call (`doctor` runs only their `--version` and login status commands, never prints the login output, and calls no model). It does not apply the recommended changes or measure whether they worked; `change applied` only records a change you already made. Records nobody labelled are reported as unlabelled, never guessed.
