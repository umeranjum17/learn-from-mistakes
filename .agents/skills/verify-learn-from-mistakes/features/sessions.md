# Agent sessions (`sessions` source: Claude Code)

## Sub-features
A `sessions: { type: sessions, agents: [auto] }` source (`agents`: `auto` or
`claude`) makes `ingest` and `retro` read this repo's Claude Code sessions from
`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<id>.jsonl` and each session's
`<id>/subagents/**/agent-*.jsonl`, streamed line by line. Store roots come only
from env overrides. Files older than the read range (this window and the last,
and back to one window before the first applied change) are skipped by mtime;
a session is read when its file or any of its subagent files is in range.
A session counts when the cwd of its first record is the project dir, a subdir,
or a `git worktree list` path, and not under `.lfm/`; a subagent file belongs to
its parent session. The tool's own runs are skipped: a cwd under `.lfm/`, a
first user message starting `lfm-run:`, or a session id in the store's
`invocations` table. `collect` writes one `events` row per session start, user
message, tool call, tool result, correction and interrupt, with `signal`
`tool_error`, `nonzero_exit`, `test_fail`, `retry`, `correction` or
`interrupt`, a `file:line` ref and an excerpt of at most 300 characters: whitespace is
collapsed, the first 4000 characters are redacted by `src/redact.mjs`, and the
result is cut to 300 (empty with `excerpts: off`).
`test_fail` is a failed command that runs tests (`npm test`, `node --test`,
`pytest` and the like), not any command naming a test file. `retry` is a
call repeated with the same input after it failed and before it succeeded. The run output adds each
source's counts: for sessions `sessions`, `skipped` (unknown record shapes and unreadable files) and
`metrics` (`tool_error_rate`, `corrections_per_session`, `interrupts`,
`retries`; `n/a` with no sessions, never 0). Every event in the read range is
stored, but the metrics count only events inside this window, and a session
counts when it has one of them. A sessions-only config completes
the report step.

## How to get to it (user POV)
Add `sessions: { type: sessions }` under `sources:` in `.learn-from-mistakes.yaml`,
then `learn-from-mistakes-axi retro --foreground`.

## Driving it with the public CLI
`test/sessions.test.mjs` owns the journey on the synthetic store in
`test/fixtures/sessions/claude/` (cwd placeholders filled at copy time, planted
keys built at run time): 0 sessions gives `n/a` numbers; then 4 sessions (repo,
subdir, worktree, an own-run id) with 3 tool errors, 1 interrupt, 1 correction
and 1 retry, a subagent file read, and the other project, a sibling dir with the
repo's name as a prefix, a `.lfm/` cwd, a marker session and an old file
skipped, and an unreadable file under the other project (not as root) is counted
in `skipped` while the retro completes; every planted key shape is redacted and never reaches `.lfm/` or any
output; an `invocations` session id is skipped next run; `excerpts: off` stores
none; a sessions-only config with no sessions completes; a parent file older
than the read range is read through its newer subagent file. The planted keys
cover a key after a long whitespace run, quoted values with spaces, JSON-escaped
pairs (the retried call is kept as JSON), Basic auth, URL passwords, npm and glpat
tokens and comma-split values. The helper drives `retro-sessions` (one synthetic
session in its scratch HOME, `sessions: 1`).

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && cp $SELF/examples/{defects.md,gate.sqlite,.learn-from-mistakes.yaml} .
sed -i 's/^sources:$/sources:\n  sessions: { type: sessions }/' .learn-from-mistakes.yaml
echo 'excerpts: off' >> .learn-from-mistakes.yaml
lfm retro --foreground   # sessions: 0, metrics n/a
```

On `$SELF`, counts only: an untracked `.learn-from-mistakes.yaml` with only the
sessions source and `excerpts: off`, then `time lfm retro --foreground` and
`sqlite3 -readonly .lfm/lfm.sqlite "select agent,count(*) from events group by agent"`.
Remove the config and `.lfm/` after. Never copy session text into evidence.

## Gotchas
Real stores are large: keep `excerpts: off` for any proof on real sessions.
The cwd test reads at most the lines before the first record with a cwd, so
other projects' files are not parsed whole. `returnCodeInterpretation` marks a
benign nonzero exit (such as grep with no match), so it is not a failure.
A tool use the user turned down is not a tool error; the interrupt or the
correction after it is counted. A correction is a person's message right after a tool error; an assistant reply in between means none. Codex, OpenCode, Pi and Gemini readers come later.
