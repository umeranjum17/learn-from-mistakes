# Agent sessions (`sessions` source: Claude Code, Codex, OpenCode, Pi, Gemini CLI)

## Sub-features
A `sessions: { type: sessions, agents: [auto] }` source (`agents`: `auto` or any of
`claude`, `codex`, `opencode`, `pi`, `gemini`) makes `ingest` and `retro` read this repo's sessions from each
agent's store. Claude Code: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<id>.jsonl` and each session's
`<id>/subagents/**/agent-*.jsonl`, streamed line by line. Store roots come only
from env overrides. Files older than the read range (this window and the last,
and back to one window before the first applied change) are skipped by mtime;
a session is read when its file or any of its subagent files is in range.
A session counts when the cwd of its first record is the project dir, a subdir,
or a `git worktree list` path, and not under `.lfm/`; a subagent file belongs to
its parent session. Codex sessions are the threads `${CODEX_HOME:-~/.codex}/state_5.sqlite`
lists (opened read-only): a thread counts by its `cwd` column, its rollout file is
streamed when its mtime is in range, and a subagent thread (`source` names a
`thread_spawn.parent_thread_id`) belongs to the top of its spawn chain. Its signals:
`Process exited with code N` or `Exit code: N` (N not 0) in the header of a shell call's output
(`exec_command`, `shell`, `local_shell_call`: the lines before `Output:`, starting the output), else a
legacy shell's JSON `metadata.exit_code`; a code-mode script's first nonzero nested `"exit_code": N`; `patch_apply_end` with `success: false`; and
`turn_aborted` with reason `interrupted`. Other tools never give an exit code from their text. Its own
user-role inputs (`# AGENTS.md instructions`, `<environment_context>`, tags with attributes such
as `<codex_internal_context source="goal">`, but not an `<image name=...>` label) are not person
messages. OpenCode sessions come from every `*.db` in
`${XDG_DATA_HOME:-~/.local/share}/opencode` with the `session`, `message` and `part`
tables (others are ignored), each opened read-only and skipped when neither it nor its
`-wal` changed in range: a session counts by `session.directory` and its `time_updated`,
and one with a `parent_id` belongs to its top parent. Its signals: a tool part with
`state.status` `error` (`Tool execution aborted` and a rejected permission are not
failures), a completed tool part whose `metadata.exit` is not 0, and an assistant message
whose `error.name` is `MessageAbortedError` (the interrupt, placed after the tools it cut
off). A user message is one event over its non-synthetic text and file parts, so the
`lfm-run:` marker is found after an attached prompt file (a leading quote is ignored).
Refs are `file:line` for Codex, Pi and Gemini and `db:<db file>:<table>:<rowid>` for OpenCode.
Pi: `${PI_CODING_AGENT_SESSION_DIR:-${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions}/*/*.jsonl` whose header `cwd` is this repo (a fork skips its parent's copied entries); `toolResult.isError` the failure (`Command exited with code N` the exit, `Command aborted` none), `stopReason: aborted` the interrupt.
Gemini CLI: `${GEMINI_CLI_HOME:-~}/.gemini/tmp/<slug>/chats/session-*.jsonl` and `chats/<session id>/*.jsonl` subagents, the slug from `.gemini/projects.json`; the last record per message id counts, `$set.messages` replaces, `$rewindTo` drops from one id; `status: error` or a shell output ending `Exit Code: N` the failure, `cancelled` the interrupt.
The reader skips the tool's own runs: a cwd under `.lfm/`, a
first user message starting `lfm-run:`, or a session id in the store's
`invocations` table. The run's own agent calls ([analyse.md](analyse.md)) write
the marker and the table; the synthetic fixtures prove the skip. `collect` writes one `events` row per session start, user
message, tool call, tool result, correction and interrupt, with `signal`
`tool_error`, `nonzero_exit`, `test_fail`, `retry`, `correction` or
`interrupt`, a `file:line` ref and an excerpt of at most 300 characters: whitespace is
collapsed, the first 4000 characters are redacted by `src/redact.mjs`, and the
result is cut to 300 (empty with `excerpts: off`).
`test_fail` is a failed command that runs tests (`npm test`, `node --test`,
`pytest` and the like), not any command naming a test file. `retry` is a
call repeated with the same input after it failed and before it succeeded. The run output adds each
source's counts: for sessions `sessions` and `skipped` (unknown record shapes and unreadable files). A store that cannot be opened or read (a Codex `state_5.sqlite` or an OpenCode `.db` that is not a database) is not counted: the retro fails with a usage error naming that agent and its store path.
Its numbers (`tool_error_rate`, `corrections_per_session`, `interrupts`,
`retries`; `n/a` with no sessions, never 0) come from the `metrics` step for this
window and the last ([metrics.md](metrics.md)). Every event in the read range is
stored, but the numbers count only events inside a window, and a session
counts when it has one of them. A sessions-only config completes
the report step.

## How to get to it (user POV)
Add `sessions: { type: sessions }` under `sources:` in `.learn-from-mistakes.yaml`,
then `learn-from-mistakes-axi retro --foreground`.

## Driving it with the public CLI
`test/sessions.test.mjs` owns the journeys on the synthetic store in
`test/fixtures/sessions/claude/` (cwd placeholders filled at copy time, planted
keys built at run time): 0 sessions gives `n/a` numbers; then 4 sessions (repo,
subdir, worktree, an own-run id) with 3 tool errors, 1 interrupt, 1 correction
and 1 retry, a subagent file read, and the other project, a sibling dir with the
repo's name as a prefix, a `.lfm/` cwd, a marker session and an old file
skipped, and an unreadable file under the other project (not as root) is counted
in `skipped` while the retro completes; every planted key shape is redacted and never reaches `.lfm/` or any
output; an `invocations` session id (a row in the store's `invocations` table) is skipped; `excerpts: off` stores
none; a sessions-only config with no sessions completes; a parent file older
than the read range is read through its newer subagent file. The planted keys
cover a key after a long whitespace run, quoted values with spaces, JSON-escaped
pairs (a retried call's input is matched as its plain string values), Basic auth, URL passwords, npm and glpat
tokens and comma-split values. A second journey reads synthetic Codex rollouts
(`test/fixtures/sessions/codex/`, listed by a `state_5.sqlite` the test makes) and
OpenCode databases the test makes (`opencode.db`, a `channel.db` with a worktree session,
and a `notes.db` of another program): 4 sessions with 60 events, a subagent of each counted
in its parent session, the other dir, `.lfm/`, marker (after an attached file), old,
missing-rollout and foreign-db sessions skipped, a bad line, a bad part and a text part with
no text in `skipped`, exactly 2 corrections (not the goal wrapper, not the message after an
interrupt), 2 interrupts, 2 retries, 4 test failures (two of them `bash -lc` wrapped), 4
nonzero exits (one a code-mode script) and 5 tool errors (failed patches by their `patch_apply_end`; a successful call whose output reads `Exit code: 2` or `"exit_code": 1`, or a non-shell tool whose output reads `Exit code: 1` after `Output:`, is not one), planted keys redacted, the
`invocations` ids of both agents skipped on a second run, and every OpenCode database
byte-identical after both runs. A third journey reads synthetic Pi and Gemini CLI stores: 3 sessions, 25 events, one correction, interrupt, retry, test failure and tool error per agent, own runs, other projects and old files skipped, one bad line each in `skipped`, keys redacted. The helper drives
`retro-sessions` (one synthetic Claude Code, Codex and OpenCode session each in its
scratch HOME and XDG dir, `sessions: 3`, its `test-fails` match rule tagging all three, the OpenCode file unchanged).

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
`sqlite3 -readonly .lfm/lfm.sqlite "select agent,count(*) from events group by agent"`
(claude, codex, opencode, pi and gemini rows when those agents ran here). Hash the OpenCode
`*.db` files before and after.
Remove the config and `.lfm/` after. Never copy session text into evidence.

## Gotchas
Real stores are large: keep `excerpts: off` for any proof on real sessions.
The cwd test reads at most the lines before the first record with a cwd, so
other projects' files are not parsed whole. `returnCodeInterpretation` marks a
benign nonzero exit (such as grep with no match), so it is not a failure.
A tool use the user turned down is not a tool error; the interrupt or the
correction after it is counted. A correction is a person's message right after a tool error; an assistant reply in between means none, but a later successful result in the same batch does not clear the error; an interrupt does too (it is its own signal). Wrapper messages (Claude Code's commands, hooks, reminders; Gemini's injected context and slash commands) are not person messages and do not clear it; an image-only message is one. A read-only open of a WAL database can leave empty `-wal` and `-shm` files beside
it; the database file itself never changes.
