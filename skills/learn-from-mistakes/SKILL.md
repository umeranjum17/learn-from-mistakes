---
name: learn-from-mistakes
description: Label a defect log for the lfm CLI and recommend changes for its repeated causes. Use when asked to find what keeps going wrong in past agent work, to run a retro with counts, or to label records for lfm.
---

# Learn from mistakes

`lfm` does the counting. You do the judgement: which records are real failures, what caused each one, and what change would stop it. Never edit the sources, and never edit AGENTS.md, CLAUDE.md, skills or config. Your output is recommendations only.

## 1. Ingest

```sh
lfm ingest            # in the project that has .learn-from-mistakes.yaml
```

It prints the state dir. `records.jsonl` there holds one JSON object per log bullet: `id`, `source`, `line`, `date`, `text`. Run `lfm --help` to see every command and option; each command prints a `next:` hint on stderr.

## 2. Label every record you read

Write `labels.jsonl` in the state dir, one line per record:

```json
{"id":"<record id>","event":true,"cause":"<cause id from the config, or other>","why":"<25 words or fewer: what happened, in the record's own terms>"}
```

Optional fields: `"duplicate_of":"<id of the earlier record about the same incident>"`, `"occurrences":2` (the record names that many separate dated incidents), `"confidence":"medium"` (when the cause is inferred, not stated).

Rules:
- `event: true` only when the record describes something that went wrong. Fix notes, new rules, status snapshots, plans and corrections are `event: false` (use cause `not-an-event`).
- A consequence of an incident is not a repeat of it. A recovery problem after a crash is its own cause, not a second crash.
- A shared keyword is not a shared cause. Read what happened. "database is locked" in an editor's own index is not the same cause as workers blocking each other on a shared database.
- Same incident (same object, same time window, same cause) logged twice: label the later record with `duplicate_of` the earlier one. It is counted once.
- Use `other` for a real failure that no configured cause names, and say the mechanism in `why`. Do not stretch a cause to fit.
- Label only what you read. Records you skip stay unlabelled, and `lfm` reports them as not analysed. That is correct; never guess labels to fill coverage.

## 3. Count

```sh
lfm count             # or just `lfm`
```

A cause is repeated when one source shows at least `repeat.min_incidents` incidents on `repeat.min_days` days. Log counts come from your labels. Store counts come from typed failure rows matched by the config's `match` rule. They are never added together.

The default output is TOON. Add `--json` to get the same data as JSON under the `lfm-report.v1` schema, and `--full` to add non-content evidence ids only: store row ids and any accepted `source:row id` proposal refs, plus applied-change ids/refs (see §6). A record's text is never turned into an id, so a ref that is a record id is not listed.

## 4. Recommend changes for repeated causes

Write `proposals.jsonl` in the state dir, one line per change:

```json
{"cause":"<cause id>","target":"<file, script, config or upstream tool>","owner":"<who would make it>","change":"<the exact change, one sentence>","refs":["<record id>","<store source>:<row id>"]}
```

- One change per line, at most five per report. Prefer a check, a script or a deleted rule over more prose.
- Every ref must be a record id or a `source:row id`. `lfm report --full` lists the non-content evidence it accepted (`source:row id` refs only), and marks a proposal whose evidence does not resolve.

## 5. Report

```sh
lfm report            # default TOON; --json for lfm-report.v1; --full adds evidence ids
```

The machine and default output carries identifiers and counts only — never record text, your label `why`, or proposal `change` text. That keeps a report safe to share. To read your own labels back, open `labels.jsonl` and `proposals.jsonl` in the state dir.

Exit 1 means a label, proposal, or change-ledger problem; the output counts the problems (their text is not printed). Fix them and run again.

## 6. Record a change you applied

```sh
lfm change applied --cause <cause id> --ref <git sha or sha256:...>   # --at <ISO-8601> to backdate
```

- `<cause>` must be a cause key from the config; `other` is never recordable.
- `<ref>` is the version id of the change: a git commit sha (7-40 hex) or `sha256:<64 hex>` of the changed file.
- The ledger holds ids, cause keys and times only — there is no free-text field — and the report then shows per cause `changes: { count, last_at }` (`--full` adds `change_ids`/`change_refs`).
