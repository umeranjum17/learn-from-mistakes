<p align="center"><img src="docs/logo.svg" width="96" height="96" alt="learn-from-mistakes logo"></p>

<h1 align="center">learn-from-mistakes</h1>

<p align="center">Find the mistakes your coding agents keep repeating, with the evidence for each, and a short list of changes to stop them.</p>

`learn-from-mistakes-axi` is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup (`npx -y learn-from-mistakes-axi`).
- It's built for agents: TOON output by default, `--json` and `--full` when asked, a contextual `next:` hint that names the likely next command, and the bare command does the main job (the report).
- The skill below only handles discovery; agents learn the tool by using it.

## Quick Start

> **Not published to npm yet.** The `npx -y learn-from-mistakes-axi` commands below work once the package is published. Until then, run the CLI from a checkout (see [Manual CLI](#manual-cli)).

Install the skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx -y skills add umeranjum17/learn-from-mistakes --skill learn-from-mistakes -g -a claude-code -y
```

That is the entire setup - no npm install needed once the package is published.
`-a` names your agent (`claude-code`, `codex` or `opencode`; repeat it for several) and `-y` skips the installer's questions.
The skill teaches your agent to run the tool through `npx -y learn-from-mistakes-axi`, so the CLI comes along on demand.
It stays a short stub and sends the agent to `npx -y learn-from-mistakes-axi --help` and `guide` for the current procedure, so an installed copy cannot go stale against a newer CLI.
Its frontmatter also includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/learn-from-mistakes what keeps going wrong here?
```

Or just ask in plain words - "what keeps going wrong in this project? the log is defects.md", or "Use the learn-from-mistakes skill to label my records, propose causes, then show the report." - and the agent loads the skill on its own when it recognizes the task.
It writes `.learn-from-mistakes.yaml` if the project has none, labels each record, and shows the repeated causes with counts and proposed changes.
The report itself carries only ids and counts; the recommended changes are in `proposals.jsonl` in the state dir, or ask your agent to summarise them.

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

Needs Node 22.13 or newer. From a checkout (until the package is published):

```sh
git clone https://github.com/umeranjum17/learn-from-mistakes
cd learn-from-mistakes && npm install && npm link   # puts learn-from-mistakes-axi on your PATH
```

1. Run `learn-from-mistakes-axi init` in your project. It writes `.learn-from-mistakes.yaml` if the project has none (otherwise it prints `already set up` and any gaps), with a worker and a different judge from the agent CLIs found, the sources it detects, and excerpts on (`--no-excerpts` writes them off). Or write the file yourself:

   ```yaml
   name: my-project
   sources:
     log: { type: markdown-log, path: defects.md }   # each "- " bullet is a record; a YYYY-MM-DD in it dates it, else its "## 2026-03-02" heading
     # gate: { type: no-mistakes, path: ~/.no-mistakes/state.sqlite }   # optional: no-mistakes store, this repo's failed steps read-only
     # sessions: { type: sessions }   # optional, one per config: this repo's Claude Code sessions under ${CLAUDE_CONFIG_DIR:-~/.claude}, read-only
   causes:
     agent-exit-wait:
       description: A pipeline step fails because the agent's output pipe stays open.
       # match: { source: gate, error_contains: "wait delay expired" }  # optional: no-mistakes store, counts typed rows
       # match: { source: sessions, signal: test_fail, tool: Bash, text_contains: "FIXTURES" }  # or a sessions source: any of signal, tool, text_contains
   repeat: { min_incidents: 3, min_days: 2 }
   ```

2. Run `learn-from-mistakes-axi ingest --dir .`. It prints the state dir: `.lfm/` next to `.learn-from-mistakes.yaml`. The tool writes `.lfm/.gitignore` (`*`) whenever it writes state there and finds none, so the state is never committed and you edit no `.gitignore` of your own. An existing `.lfm/.gitignore` is never overwritten: it must contain the line `*` with no line starting with `!`, or the write exits 2 before any state is written. To keep state outside the project instead, set `state_root: <dir>` in `$LFM_HOME/config.yaml` (`LFM_HOME` defaults to `~/.learn-from-mistakes`); the state then goes to `<dir>/<name>`.
3. Ask your agent to use the learn-from-mistakes skill (or to follow `learn-from-mistakes-axi guide`). It writes `labels.jsonl` and `proposals.jsonl` in the state dir.
4. Run `learn-from-mistakes-axi` for the report. A bare command, or `report`, prints the repeated causes for the project you are in. The recommended changes are in `proposals.jsonl` in the state dir, or ask your agent to summarise them.

## Why

Agent fleets write down what went wrong: a defect log, a pipeline's failed steps. The same cause turns up again and again, yet nobody counts it, so the fix never gets priority. Counting by keyword is wrong too: "database is locked" in one tool is not the same cause as in another.

`learn-from-mistakes-axi` splits the work. Your agent reads each record and judges what happened, following the CLI's own `guide`. The CLI does the arithmetic: it merges duplicates, counts each source separately, checks that every recommendation cites real records, and lists what was never read.

## Command line

```
learn-from-mistakes-axi           print the project's repeated-cause report (same as `report`)
learn-from-mistakes-axi init [--worker <runner>] [--judge <runner>] [--no-excerpts]   write .learn-from-mistakes.yaml once: a worker and a different judge from the agent CLIs found, and the sources found
learn-from-mistakes-axi guide     print the agent procedure: config, ingest, label, propose, report
learn-from-mistakes-axi ingest    read the configured sources (read-only) into the state dir
learn-from-mistakes-axi count     print the counts (same projection as `report`)
learn-from-mistakes-axi report    print the report; --full adds evidence ids, --json prints JSON
learn-from-mistakes-axi change applied --cause <cause> --ref <ref> [--at <time>] [--what <text>] [--why <text>]   record an applied change in the ledger
learn-from-mistakes-axi changes   print every applied change (lfm-changes.v1) with its what and why
learn-from-mistakes-axi retro [--wait [<time>] | --foreground]   ingest and report as one saved run, in a background worker
learn-from-mistakes-axi status    print the last saved run and its steps (--run <id> for another)
learn-from-mistakes-axi runs      list the saved runs, newest first (the last 10)
learn-from-mistakes-axi attach    follow the run: its step lines and states as they come, until it ends
learn-from-mistakes-axi logs --step <name>   print one step's log (--run <id> for another run)
learn-from-mistakes-axi abort     stop the running run; it ends as cancelled
learn-from-mistakes-axi rerun [--resume] [--run <id>] [--wait <time>]   start a new run with the current config (default: follows the last run); --run <id> names the run it follows; --resume finishes that run from its first step that is not completed
learn-from-mistakes-axi agents    list the agent CLIs the tool can start: usable, version, login presence, default model
learn-from-mistakes-axi agents --test <runner>   one live call to that agent CLI, or `acp:<target>` through acpx (costs tokens): it must answer and write no file
learn-from-mistakes-axi --help    show the commands and options
learn-from-mistakes-axi --version show the version
```

Every command stays useful:

- Default output is **TOON** (compact, token-lean). For `report`/`count`, `--json` prints the same data as JSON under the versioned `lfm-report.v1` schema (`changes --json` is `lfm-changes.v1`, below). `generated_at` is when the report ran; `ingested_at` is when `ingest` last read the sources. The added field keeps the schema at `lfm-report.v1`.
- `--full` adds allow-listed evidence **ids** — non-content source row ids only, never a content-derived record id or record text.
- `change applied` appends one versioned entry (`chg-<n>`, cause key, version id, time) to the append-only `<state dir>/changes.jsonl` ledger, and the report then shows per cause how many applied changes exist (`changes: { count, last_at }`, top-level `ledger: { entries }`; `--full` adds `change_ids`/`change_refs`). `<cause>` must be a cause key from the config (`other` is never recordable); `<ref>` is a git sha (7-40 hex) or `sha256:<64 hex>`; `--at` defaults to now. `--what` and `--why` are optional owner-written text, one line of 1-200 characters each (trimmed; a newline or control character is rejected); the report never prints them.
- `changes` prints every ledger entry in ledger order under the `lfm-changes.v1` schema (TOON by default, `--json` for JSON). It needs only the config, not `ingest`.
- `retro` saves a run in `<state dir>/lfm.sqlite`: a `runs` row with its status and the pid of the process that runs it, and one `steps` row each for `collect` (ingest), `metrics` (the numbers, below), `bundle` (the file the run's agents read, below) and `report` (the counts with the labels already in the state dir). A detached worker runs the steps, so the run goes on when the terminal or the calling agent ends; `retro` returns at once, `--wait 8m` waits up to that time and prints the outcome (a bare `--wait` waits 8 minutes), and `--foreground` runs the steps in the same process. One run runs at a time: a second `retro` exits 2 and names the running run. A failed step fails the run and exits 1; `status` and `runs` show the saved runs, and `status` exits 3 before the first one.
- A run whose worker stopped without ending it (a crash or a kill) shows as `interrupted` in `status` and `runs`, and no longer blocks a new `retro`. `rerun --resume [--run <id>]` runs an interrupted, cancelled or failed run again from its first step that is not completed; completed steps keep their output and do not run again. A SIGTERM or SIGINT to the worker ends the run as `cancelled`.
- `attach` prints each step's state changes and log lines as they come and exits when the run ends (0 when it completed). Each step's log is `<state dir>/runs/<id>/<step>.log`, holding its latest attempt; a step that has not started in its run has no lines. `logs --step collect` prints one. `abort` sends SIGTERM to the run's worker (SIGKILL after 3 s) and marks the run `cancelled`. A plain `rerun --run <id>` starts a new run with the current config, names run `<id>` in its output, and leaves run `<id>` as it was; `rerun --resume --run <id>` is the one that finishes run `<id>`.
- `agents` lists the agent CLIs the tool can start as its own workers (claude, codex, opencode, pi, gemini, and any ACP agent as `acp:<target>` through `acpx`): usable (found on an absolute PATH entry, and `--version` exits 0; relative PATH entries are skipped), version, tools (`off`, `read-only`, or `unconfirmed` for acp), login presence (file and variable names only, never their contents) and the default model, the first model `src/models.json` lists for that runner (none for pi, gemini and acp, so the runner's own default applies; a configured model such as `LFM_MODEL` applies only where that runner lists it, or where its role pins that runner). A runner whose tool-off mode is not confirmed is listed with `not offered:` and the reason, and is never picked as worker or judge: gemini (its read-only `--approval-mode plan` is not yet confirmed in headless mode) and acp (`acpx --deny-all` only denies the permission requests an agent sends; pi and opencode run their tools without asking). With a project config it adds the resolved `worker` and `judge`; a judge that resolves to the worker's binary and model exits 1 with the fix. `agents --test <runner>` (or `--test acp:<target>`, in `runs/test-acp-<target>/`) makes one live call in `<state dir>/runs/test-<runner>/` with tools off (Codex and Gemini: read-only) and no saved session, except OpenCode and Gemini, which keep theirs; it works on a runner that is not offered, to check it: it asks the agent to write `x.txt` and exits 1 if any file appears, if an attempt gets no answer within `caps.timeout` (each attempt has its own; a call makes at most 3 attempts), or with the agent's own error; a plain-text answer passes and prints as the reply.
- The `collect` step also reads a `sessions` source: the Claude Code sessions run in this repo, a subdir or one of its git worktrees, changed since the start of this window and the last (`window`, default `7d`), or earlier when an applied change needs before-numbers. It skips the tool's own agent runs and any session file it cannot read (counted in `skipped`). It saves one `events` row per session start, user message, tool call, tool result, correction and interrupt. Its run output carries each sessions source's `sessions` and `skipped`.
- The `metrics` step saves the numbers for this window (`current`, from `window.current_start` on) and the last one (`previous`, the same length before it) in the store's `metrics` table, and the run output lists them (`metrics[]{name,current,previous}`). Each source gives its own: a sessions source `tool_error_rate`, `corrections_per_session`, `interrupts` and `retries` over the events in the window; a defect log `defects`, its records dated in the window. `cause_count:<cause>` counts the items a cause's `match` rule tagged in the window: gate rows whose error has `error_contains`, or session events with that `signal`, `tool` and `text_contains`. Each row takes one cause, the first matching rule in config order. `text_contains` matches the text of signal events only: failed tool results (tool errors, non-zero exits, failed tests), retries and corrections. A retry is matched on its call's input values as plain text (for Bash, the command). A successful call, its output or a plain message is never checked, so the rule matches nothing there. A rule tags signal events only, so `tool: Bash` alone tags failed Bash results and retries, never a successful call. The text is read whole, so it works with `excerpts: off`. Defect logs sum into one `defects`. A number with nothing to count is `n/a` (NULL in the store), never 0: a metric whose source type is not configured, a target no source measures, a cause with no `match` rule, session numbers with no session in the window, a defect log with no dates.
- A no-mistakes source reads only this repo's failed steps: the store's runs of a repo whose checkout is this project or one of its git worktrees, or whose upstream URL is its `origin`. A store with no `repos` table is not a no-mistakes store and exits 2.
- The `bundle` step writes `<state dir>/runs/<id>/bundle.md`, the one file the run's own agents read: the metrics table with each target, the follow-ups (none yet), the signal clusters (this window's session events with a failure signal, grouped by tool and signal, largest first, each with its 3 latest events) and the records no `match` rule tagged (this window's and the undated ones). Each item has an id (`[c1]` a cluster, `[e<n>]` an event row, `[r<n>]` a record row), its refs (session id and `file:line`, or the record's `file:line` or `db:step_results:<id>`) and, with `excerpts: on`, an excerpt of at most 300 characters. Every string in it goes through the same redaction as the session excerpts. With `excerpts: off` it holds pointers and counts only, never record or session text. Items that would pass `caps.bundle_chars` (at least 1000) are dropped, and its last line counts them; the step log gives the items, dropped items and characters.
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

`learn-from-mistakes-axi changes --json` is the machine contract for applied changes, so a retro can join its own verdict (for example "Helped? yes/no/unclear") on a change:

```json
{
  "schema": "lfm-changes.v1",
  "generated_at": "2026-10-12T09:00:00.000Z",
  "project": "my-project",
  "changes": [
    { "id": "chg-1", "cause": "server-memory-kill", "ref": "abc1234", "at": "2026-10-11T08:00:00.000Z",
      "what": "Run builds in their own memory group", "why": "The memory killer stopped the server three times" }
  ]
}
```

- Join on `project` + `id`. `id` is `chg-<n>` from the append-only ledger: never reused or rewritten.
- `ref` is the accepted version (a git sha or `sha256:` of the changed file); `at` is when it was applied (ISO-8601).
- `what` and `why` are exactly the text the owner passed to `change applied`, or `""` when none was given.
- Pin `schema: lfm-changes.v1`. An invalid ledger exits 1 and names `file:line` only, with nothing on stdout.

## Privacy

The report (default, `--json` and `--full`) is **privacy-bounded**: identifiers and counts only. It never prints record text, a label's `why`, a proposal's `change`, a change's `what`/`why`, cause descriptions, source paths, branches or error text, and never turns a record's text into an id. `changes` is the one output that prints free text, and only the `what`/`why` the owner wrote with `change applied` to be shared; it never carries record text, label or proposal prose. That is why the default and `--full` report output can be logged, shared or handed to another tool without leaking the private records the counts came from. `--full` is not permission to print private evidence; it only adds non-content source row ids. Error diagnostics are the one exception: they may name a source by its config id (for example `source log: cannot read (ENOENT)`) rather than its path, and never echo record text.

The state dir is not bounded: `.lfm/records.jsonl` holds the full text of every defect-log record, `lfm.sqlite`'s `records` table holds the same text for defect bullets and the redacted error of each failed gate step, and `labels.jsonl`/`proposals.jsonl` hold your agent's prose. It stays in the project's `.lfm/`, which the tool git-ignores with its own `.lfm/.gitignore` (an existing one is never overwritten; it must contain the line `*` with no line starting with `!`, or `ingest`, `change applied` and `retro` exit 2 before writing any state), so none of it reaches a commit. Treat `.lfm/` as private as the sources it was read from. Each run's `bundle.md` holds redacted excerpts of those records and session events, or none with `excerpts: off`. With a `sessions` source, `lfm.sqlite` also keeps an excerpt of each session failure, retry and correction: at most 300 characters, with API keys, tokens, a password in a URL, private keys, Bearer and Basic credentials, `KEY=value`, `"key": "value"` and `--key value` secrets whose key name contains token, secret, password, key or auth, and email addresses, replaced by `[redacted]`; a wider key list comes in a later version. `excerpts: off` keeps none.

## Exit codes

| Code | Meaning | stderr |
| --- | --- | --- |
| `0` | ok | a `next:` hint |
| `1` | an input problem: a label, a proposal or the existing change ledger has a problem, including a line that is not valid JSON; for `agents`, and for a fresh `init`, a worker or judge problem; for `agents`, also a failed `--test` call | `error: <file>:<line>: not valid JSON`, or for the report one `problem: <file>:<line>: ...` line each (the line and the rule broken, never record text, a record id or a ref) and `problems: N`; then `next:` |
| `2` | bad usage or config: an unknown command or option, a flag the command does not take, a missing or invalid value, a bad `.learn-from-mistakes.yaml`, missing state | `error:` naming the flag or value (a value longer than 80 characters or with control characters shows as `(invalid value)`; file paths print whole, and a `--dir`/`--labels`/`--proposals` path with a control character is rejected), then `next:` with the allowed form or a runnable command, never the whole usage |
| `3` | the sources hold nothing | `next: learn-from-mistakes-axi ingest` |

A rejected `change applied` never touches the ledger. A missing prerequisite or empty source prints an actionable `next:` command; it never invents events.

## Model

The label/propose reading is agent work: do it on the cheap default model of the agent CLI that runs it; `learn-from-mistakes-axi agents` lists each one.
Never take Opus, Sonnet or Sol as the default.
To use your own model instead, set `LFM_MODEL` (or `worker.model`) to its id. With `worker.runner: auto` it must be a model an agent CLI lists as its default, else set `worker.runner` to the CLI that runs it (`learn-from-mistakes-axi guide` then names it in the procedure).

## What it does not do

`learn-from-mistakes-axi` never edits your sources or instructions, writes only its own config (`init`, once) and state dir, and makes no network or model calls itself; only `agents --test` starts your own agent CLI, which calls its model. It does not apply the recommended changes or measure whether they worked; `change applied` only records a change you already made. Records nobody labelled are reported as unlabelled, never guessed.
