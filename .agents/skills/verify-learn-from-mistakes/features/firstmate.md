# Firstmate home source and gate failures by step (`firstmate`, `no-mistakes` sources)

## Sub-features
Opt-in only: `init --firstmate <home>` writes `home: { type: firstmate, path: <home> }`, or the user
writes it; nothing detects a home. `src/sources/firstmate.mjs` reads, read-only, under `<home>/state`:
each `*.status` file (lines `<state> [at=<epoch>] [<tag>...]: <text>`; a line with no `at=` takes the
last stamp above it; `needs-decision` is a decision, `blocked` a block) and each `*.msg` in a `*.inbox`
folder or its `handled/` (a steer, timed by its `at=<epoch>` line, tagged by its first `[tag]`).
`<home>/data/defects.md` goes through the markdown-log reader (adds to `defects`);
`<home>/config/targets.tsv` (`metric op target owner rule`, tab-separated, header optional) overrides
`targets:`. An entry with no time is skipped and counted in `doctor`. Metrics: `decisions`,
`blocks`, `steers`, `interventions_per_merge` (their sum over `merged`, n/a with no github source).
The no-mistakes source adds `gate_failures` and `gate_failures:<step>` and checks the store's
columns (`PRAGMA table_info`): one missing exits 2 `unknown store schema (no <table>.<column>)`.

## Driving it with the public CLI
`test/github.test.mjs` owns the journey ("init --firstmate"): a synthetic home (3 status files,
4 messages, a defect log, a targets file) gives decisions 2/0, blocks 1/1 (target `<= 0` missed),
steers 2/1, interventions_per_merge 0.5/0.667, `first_pass` target `>= 80`; a planted token never
shows. `test/sessions.test.mjs` asserts `gate_failures` by step; `test/cli.test.mjs` the dropped column.

Real-product proof (`$SCR` scratch, synthetic home with the demo name only):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
H=$SCR/home-fixture; mkdir -p $H/state/lane.inbox && cd $SCR/ky
printf 'needs-decision [at=%s]: Umer picks a name\nblocked: waiting\n' $(date +%s) > $H/state/lane.status
printf 'at=%s\n[steer] use the demo data\n' $(date +%s) > $H/state/lane.inbox/001.msg
lfm init -y --no-skill --firstmate $H && lfm doctor; lfm retro --foreground
sqlite3 -readonly .lfm/lfm.sqlite "select window,name,value from metrics where name in ('decisions','blocks','steers','interventions_per_merge') or name like 'gate_failures%'"
```

On a project with no `--firstmate`, `doctor` lists no `home` source.

## Gotchas
The home is never written; the run's state stays in the project's `.lfm/`.
