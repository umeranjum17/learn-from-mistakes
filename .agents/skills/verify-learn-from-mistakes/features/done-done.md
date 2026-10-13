# done-done source (`done-done` source)

## Sub-features
A `proof: { type: done-done, apps: [<app>, ...] }` source makes `ingest` and `retro` read done-done's
verify run state, read-only, from `<path>/runs/<app>/<run-id>/run.json` (`src/sources/done-done.mjs`).
`apps` is required: the done-done app names the user chooses (each one path segment). `path` is
done-done's home; unset, it is `$DONE_DONE_HOME`, else `~/.done-done`, as done-done documents it.
Nothing is detected: `init` never writes this source. Each failed step of a verify run whose
status is `failed`, or `completed` with result `fail`, `inconclusive` or `overridden` (moved past its
gate; done-done counts it a fail), is one record:
id `<source>:<app>/<run-id>/<step>`, `step`, `ref` the run file, `date` the step's end day (else the
run's last update) and `text` `verify <result>: <reason>` after `excerpt()` (redacted, at most 300
characters; none with `excerpts: off`). The reason is the run's when it names that step, else the
step's own first finding, else `<step>: failed (exit <n>)`. A run with no failed step (a timed-out
journey, or `setup:` before the first step) is one record for the step its reason names. Passed,
cancelled, unfinished (`pending`, `running`, `awaiting_approval`) and maintain runs are not records; a
folder with no `run.json` (the judge cache) is skipped. A run before the read's start (its `updated`, else
`created`, else the file's mtime) is skipped unread, so an old run in a newer schema never stops anything.
A `run.json` in the read range whose schema is not 2 stops `ingest` and `retro` with exit 2, `error: source <id>: <file> is done-done run schema <n>; this
version reads schema 2` and `next: update learn-from-mistakes-axi to read it, or remove
sources.<id> ...`; a non-JSON one or bad `steps` exits 2 with `next: done-done status --run <id>`, an
unreadable one with `chmod -R u+r`. `doctor()` gives the records and those in the window; an app
with no runs folder is a warn whose fix lists done-done's app names. Receipts are not read yet.

## How to get to it (user POV)
With done-done installed and a verify run done: add `proof: { type: done-done, apps: [<app>] }`
under `sources:`, then `learn-from-mistakes-axi doctor` and `learn-from-mistakes-axi retro --foreground`.

## Driving it with the public CLI
`test/cli.test.mjs` owns the journey ("a done-done source"): synthetic runs under a throwaway
`DONE_DONE_HOME` (fail with a planted token, inconclusive with no failed step, overridden with a
failed judge, a `setup:` failure, pass, running, the judge folder) give exactly 4 records with the
run files as refs in `records.jsonl` and in the run store; `doctor --json` warns for the misspelt
app; a schema 3 run and a `steps: [null]` run exit 2 with the fix.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout; synthetic runs only):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
mkdir -p $SCR/p $SCR/dd/runs/notes/r1 && cd $SCR/p
echo '{"schema":2,"run_id":"r1","kind":"verify","app":"notes","status":"completed","result":"fail","reason":"check: shot.png: judge says wrong screen","updated":"'$(date -u +%F)'T10:00:00Z","steps":[{"name":"check","status":"failed","exit":1}]}' > $SCR/dd/runs/notes/r1/run.json
printf 'sources:\n  proof: { type: done-done, apps: [notes], path: %s }\n' $SCR/dd > .learn-from-mistakes.yaml
lfm ingest && cat .lfm/records.jsonl && lfm doctor && lfm retro --foreground
```

`retro` needs the user's `agent` and model set in `$LFM_HOME/config.yaml` (with the record in the
window, the worker labels it); a live run uses the worker the brief names.

Before this source: the same config exits 2 `sources.proof.type must be one of ...`.

## Gotchas
A failed plain `done-done check` writes no file, so only verify runs reach the retro.
A run still shown as `running` whose runner died is not read until done-done marks it.
