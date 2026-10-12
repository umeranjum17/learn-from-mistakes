<p align="center"><img src="docs/logo.svg" width="96" height="96" alt="learn-from-mistakes logo"></p>

<h1 align="center">learn-from-mistakes</h1>

<p align="center">Find the mistakes your coding agents keep repeating, with the evidence for each, and a short list of changes to stop them.</p>

## Why

Agent fleets write down what went wrong: a defect log, a pipeline's failed steps. The same cause turns up again and again, yet nobody counts it, so the fix never gets priority. Counting by keyword is wrong too: "database is locked" in one tool is not the same cause as in another.

`lfm` splits the work. Your agent reads each record and judges what happened, using the bundled skill. The CLI does the arithmetic: it merges duplicates, counts each source separately, checks that every recommendation cites real records, and lists what was never read.

## Install

Needs Node 22.13 or newer.

**Not published to npm yet.** These one-line installs are the proposed path and will work after the first publish:

```sh
npx -y learn-from-mistakes            # one-shot, no install (after publication)
npm install -g learn-from-mistakes    # global (after publication)
```

Until then, run it from a checkout:

```sh
git clone https://github.com/umeranjum17/learn-from-mistakes
cd learn-from-mistakes && npm install && npm link
```

Install the bundled skill for your agent (this works today, no npm publish needed):

```sh
npx skills add umeranjum17/learn-from-mistakes --skill learn-from-mistakes -g
```

## Quick start

1. Put `.learn-from-mistakes.yaml` in your project:

   ```yaml
   name: my-project
   sources:
     log: { type: markdown-log, path: defects.md }        # each "- " bullet is a record; "## 2026-03-02" headings date it
     gate: { type: no-mistakes, path: ~/.no-mistakes/state.sqlite }   # failed steps, opened read-only
   causes:
     agent-exit-wait:
       description: A pipeline step fails because the agent's output pipe stays open.
       match: { source: gate, error_contains: "wait delay expired" }  # optional: count typed store rows
   repeat: { min_incidents: 3, min_days: 2 }
   ```

2. Run `lfm ingest --dir .`. It prints the state dir (`~/.learn-from-mistakes/state/<name>`; set `LFM_HOME` to move it).
3. Ask your agent to follow [`skills/learn-from-mistakes/SKILL.md`](skills/learn-from-mistakes/SKILL.md). It writes `labels.jsonl` and `proposals.jsonl` in the state dir.
4. Run `lfm` for the report. A bare command, or `lfm report`, prints the repeated causes for the project you are in.

## Command line

```
lfm                 print the project's repeated-cause report (same as `lfm report`)
lfm ingest          read the configured sources (read-only) into the state dir
lfm count           print the counts (same projection as `lfm report`)
lfm report          print the report; --full adds evidence ids, --json prints JSON
lfm change applied --cause <cause> --ref <ref> [--at <time>] [--what <text>] [--why <text>]   record an applied change in the ledger
lfm changes         print every applied change (lfm-changes.v1) with its what and why
lfm --help          show the commands and options
lfm --version       show the version
```

Every command stays useful:

- Default output is **TOON** (compact, token-lean). For `report`/`count`, `--json` prints the same data as JSON under the versioned `lfm-report.v1` schema (`changes --json` is `lfm-changes.v1`, below).
- `--full` adds allow-listed evidence **ids** — non-content source row ids only, never a content-derived record id or record text.
- `lfm change applied` appends one versioned entry (`chg-<n>`, cause key, version id, time) to the append-only `<state dir>/changes.jsonl` ledger, and the report then shows per cause how many applied changes exist (`changes: { count, last_at }`, top-level `ledger: { entries }`; `--full` adds `change_ids`/`change_refs`). `<cause>` must be a cause key from the config (`other` is never recordable); `<ref>` is a git sha (7-40 hex) or `sha256:<64 hex>`; `--at` defaults to now. `--what` and `--why` are optional owner-written text, one line of 1-200 characters each (trimmed; a newline or control character is rejected); the report never prints them.
- `lfm changes` prints every ledger entry in ledger order under the `lfm-changes.v1` schema (TOON by default, `--json` for JSON). It needs only the config, not `ingest`.
- Each command ends with a `next:` hint on stderr (ingest also names the labelling step on stdout), so an agent can chain `ingest → report → --full → --json` without reading the docs.

Default TOON output, abridged to one cause on the example project:

```
schema: lfm-report.v1
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

`lfm changes --json` is the machine contract for applied changes, so a retro can join its own verdict (for example "Helped? yes/no/unclear") on a change:

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

The report (default, `--json` and `--full`) is **privacy-bounded**: identifiers and counts only. It never prints record text, a label's `why`, a proposal's `change`, a change's `what`/`why`, cause descriptions, source paths, branches or error text, and never turns a record's text into an id. `lfm changes` is the one output that prints free text, and only the `what`/`why` the owner wrote with `change applied` to be shared; it never carries record text, label or proposal prose. That is why the default and `--full` report output can be logged, shared or handed to another tool without leaking the private records the counts came from. `--full` is not permission to print private evidence; it only adds non-content source row ids. Error diagnostics are the one exception: they may name only the configured path you supplied (for example `defects.md: cannot read (ENOENT)`), and never echo record text.

## Use it on your own records

The `.learn-from-mistakes.yaml` above is all the configuration. Then `lfm ingest`, have your agent label, and `lfm`.

## Exit codes

| Code | Meaning | stderr |
| --- | --- | --- |
| `0` | ok | a `next:` hint |
| `1` | an input problem: a label, a proposal or the existing change ledger has a problem, including a line that is not valid JSON | `error: <file>:<line>: not valid JSON`, or for the report one `problem: <file>:<line>: ...` line each (line numbers and ids, never record text) and `problems: N`; then `next:` |
| `2` | bad usage or config: an unknown command or option, a flag the command does not take, a missing or invalid value, a bad `.learn-from-mistakes.yaml`, missing state | `error:` naming the flag or value (a value longer than 80 characters or with control characters shows as `(invalid value)`), then `next:` with the allowed form or a runnable command, never the whole usage |
| `3` | the sources hold nothing | `next: lfm ingest` |

A rejected `change applied` never touches the ledger. A missing prerequisite or empty source prints an actionable `next:` command; it never invents events.

## What it does not do

`lfm` never edits your sources, instructions or config, and it makes no network or model calls. It does not apply the recommended changes or measure whether they worked; `lfm change applied` only records a change you already made. Records nobody labelled are reported as unlabelled, never guessed.
