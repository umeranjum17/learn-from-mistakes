# Bundle step (`bundle` step, `bundle.md`)

## Sub-features
Every run has a `bundle` step between `metrics` and `report` (`src/bundle.mjs`).
It writes `<state dir>/runs/<id>/bundle.md`, the one file the run's own agents
will read, and logs `bundle.md: <n> items, <n> dropped, <n> characters`; its
`output_json` keeps `items`, `dropped`, `chars`, `clusters` and `records`.
Sections: the metrics table (this window, the last, the target), follow-ups
(`No follow-ups yet.` until the follow-up step exists), signal clusters (this
window's session events with a signal, grouped by tool and signal, largest
first, `[c<n>]` with events, sessions, days and the causes the rules tagged,
then the 3 latest `[e<n>]` events (`n` is the event's store row id: bundle-local, not a label id) with time, session id and
`file:line`) and unlabelled defect records (this window's and undated records
no `match` rule tagged, `[<record id>]` with source, ref and date). A record id is the
one labels.jsonl takes: a defect-log record's records.jsonl id, a gate row's `gate:<step id>`.
With `excerpts: on` each event and record has a `  > ` excerpt of at most 300
characters; with `excerpts: off` there is none, only pointers and counts.
With `excerpts: on`, redact() removes secret-shaped values only; plain record text stays in the bundle by design, so the canary guarantee for prose is `excerpts: off`.
`redact()` from `src/redact.mjs` runs on every string the step writes, from every
source (session excerpts, defect bullets, gate errors, refs, ids). Items that
would pass `caps.bundle_chars` (at least 1000; smaller exits 2) are dropped and a
last `Dropped <n> items ...` line counts them. Within a section, the first item
that does not fit drops it and every later item of that section, so the clusters
shown are always the top ones and their numbers have no gap.
The no-mistakes source's repo scoping, error redaction and store digest are in
[ingest.md](ingest.md); the bundle only shows what that source keeps.

## How to get to it (user POV)
`learn-from-mistakes-axi retro --foreground`, then read
`.lfm/runs/<id>/bundle.md` (the step log: `logs --step bundle`).

## Driving it with the public CLI
`test/sessions.test.mjs` owns the journey `the bundle has ids, refs and redacted
excerpts, ...`: one planted key of each one-line shape in a defect bullet and in
a gate error of this repo, the planted session keys of the fixture, and a failed
gate step of another repo in the same store (`OTHER-REPO-CANARY`). No planted
value and no other-repo row reaches `bundle.md` (the other row is not read at
all); clusters are numbered and ranked by count; every record id is in
records.jsonl or rows.jsonl of the state dir, and the bundle's ids survive a collect rerun; every item has its excerpt. `excerpts: off` gives the same items
with no excerpt and no record or session text; `caps: { bundle_chars: 1000 }`
keeps the file under 1000 characters with the dropped line, also when 40 more
causes' metrics fill it before the later headings, and 999 exits 2; a sweep of
caps from 1000 to 4000 keeps the cluster numbers a gapless prefix. A config in a
subdirectory of the checkout, with the repo row matched by its checkout path,
reads this repo's gate rows and not the other repo's.
`test/cli.test.mjs` asserts 4 steps per run, the example's bundle sections, the
`bundle:` attach line, and that a store with no `repos` table exits 2.
The helper's `retro-v2` drive (`excerpts: off`) checks the bundle has no
excerpt line, and `retro-sessions` (`excerpts: on`) checks the failed test run
is cluster `[c1]` with its `Exit code 1` excerpt.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
sqlite3 gate.sqlite "update repos set working_path = '$PWD'"   # the example store's repo is this copy
lfm retro --foreground && wc -c .lfm/runs/*/bundle.md
```

On `$SELF`, counts only: an untracked `.learn-from-mistakes.yaml` with a
sessions source, a `gate` source on the real no-mistakes store and
`excerpts: off`, then `lfm retro --foreground`, `grep -c . <bundle.md>` and
`grep -c '^  > ' <bundle.md>` (must be 0). Compare the gate items with
`sqlite3 -readonly <store> "select count(*) from step_results s join runs r on r.id = s.run_id join repos p on p.id = r.repo_id where s.status = 'failed' and p.upstream_url = '<origin>'"`.
Never copy the bundle's text into evidence. Remove the config and `.lfm/` after.

## Gotchas
Only the current window's events and records are in the bundle (and undated
records); the metrics cover both windows. A record a `match` rule tagged is
counted in `cause_count:<cause>`, not listed. The bundle is rebuilt when the step
runs again (`rerun --resume`). The cap counts JavaScript string length.
