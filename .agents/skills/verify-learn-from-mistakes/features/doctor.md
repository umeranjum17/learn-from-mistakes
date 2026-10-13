# doctor (`doctor`)

## Sub-features
`src/doctor.mjs` prints one line per check, `ok|warn|fail <label> <detail>`, and an
indented `fix: <command or edit>` under each line that is not ok; `--json` prints
`{ checks: [{ level, label, detail, fix? }], fails }`. Any `fail` exits 1, else 0.
It only reads: no state dir is made and no agent is called, except with `--live`, which writes
its one test run dir under the state dir (`runs/test-<step>`).

Checks, in order:
- `node`: Node >= 22.13 (fail).
- `git`: a git repo (warn: worktree sessions are not matched; fix `git -C <dir> init`).
- `config`: `.learn-from-mistakes.yaml` and `$LFM_HOME/config.yaml` load (fail, then no more
  checks; fix `init` when there is no project config, else edit the file the error names).
- `state`: in a git repo, `.lfm` is git-ignored (fail, fix: append `*` to `<state>/.gitignore`); ok when `.lfm` does not exist yet
  (the first run makes it with its `.gitignore`) or `state_root` moves it out of the project.
- `source <id>`: each source's registry `doctor()` hook (sessions: stores, and the sessions and
  skipped records in files written in this window; a store that is missing is named with its env variable: an
  ok detail under `agents: auto`, a warn when the agent is listed; no store at all is a warn; markdown-log and
  no-mistakes: readable, the count in the window, and the skipped entries). A read
  error is a fail with the source's own fix (a missing defect log: `check sources.<id>.path in
  <the project config's full path>, or create it: touch <path>`). No sources at all: warn.
- `agent`/`judge_agent` (the labels `worker`/`judge`): the role resolves to a usable, offered agent (`resolveRoles`), with
  version and tools. A role that does not is a fail whose fix is `set agent in <file> to X` naming the offered agents
  when there are any; otherwise `install <bin>, or set agent_path_override.<bin> in <global>` (or the install command),
  or `set agent in <file> to another agent` when the agent is usable but not offered. `<file>` is the project file when it
  set the key, else the global file. A BYOKit route that failed its own check keeps its problem and fix.
- `worker login`/`judge login`: the agent's own status command through `which()`, its
  output never printed: `codex login status` (exit 0), `opencode auth list` (a
  credential or environment variable count above 0), `pi auth check --no-refresh
  --model <m>` (exit 0; with no model, the login file). A negative answer is a fail
  with the login command; a probe that does not finish in 20 s is a warn. pi is the one
  exception: a probe that fails for any reason (exit, error, signal, timeout) is checked
  against `~/.pi/agent/auth.json` by existence only: present is a warn with the exit code,
  absent is a fail with `pi # then /login`. A pi role with no model has no probe and gets the
  file-presence check below. Claude and Gemini: login file or key variable presence (warn
  when none: it may be in the keychain). The pi case warns the same way.
- `worker model`/`judge model`: no model is a warn, fixed by `set agent_config."<agent>".model in <file>`; a
  premium name (`opus`, `sonnet`, `sol`) is a fail unless `allow_premium: true` (its fix names both files); a BYOKit
  route with no model and no default is a fail with the same `agent_config` fix.
- `identity`: the worker's and judge's (real binary, model) differ (fail: the judge
  would judge its own work; fix: `set judge_agent in <file> to another agent, or install a second agent CLI`).
- `skill <runner>`: per usable runner with a skills dir, `SKILL.md` under
  `learn-from-mistakes/` in its global dir (`${CLAUDE_CONFIG_DIR:-~/.claude}/skills`,
  `${CODEX_HOME:-~/.codex}/skills`, `${XDG_CONFIG_HOME:-~/.config}/opencode/skills`,
  `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills`, `${GEMINI_CLI_HOME:-~}/.gemini/skills`) or the project's `.claude/skills` or
  `.agents/skills` (warn; fix: copy the packaged `SKILL.md` there).
- `sign-off`: ok when `sign-off` is on PATH or `signoff: off`; otherwise a warn (plain-text fallback).
- `--live`: `worker live`/`judge live`, one `agents --test` call per resolved role with
  its own model (costs tokens): it must answer and write no file. A role that already has a
  problem or a failed model check is not called (its own fail stands: one fail, no `skip live` warn).

## How to get to it (user POV)
`learn-from-mistakes-axi doctor` in a project dir (or `--dir <project>`), after `init`.

## Driving it with the public CLI
`test/init.test.mjs` owns the journey: after `init` with fake `claude`, `opencode`,
`pi` and `gemini` (and `git`) on PATH, a synthetic Claude credential and fakes whose
login output carries a canary: exit 0 with the config, state, both sources, the worker,
both logins and identity ok, and the skill for claude and sign-off as warns; then a missing
defect log, `agent: pi`, `judge_agent: pi` and `agent_config: { pi: { model: claude-opus-5-5 } }` give
exactly 4 fails (`source log`, `worker model`, `judge model`, `identity`), each with `fix:`, exit 1
and `next: ... doctor   # again after the 4 fixes above`; the pi probe argv is
`auth check --no-refresh --model claude-opus-5-5`; the canary never prints; after the
fixes, exit 0. The helper drives `doctor` (exit 0) and `doctor-missing-log` (exit 1,
`fix: check sources.log.path ...`) in its fresh init project with fake agents.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout, `$LAB` a
lab HOME holding only a link to the lab Claude credential; no agent call, no tokens):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && cp $SELF/examples/defects.md . && labenv lfm init -y --no-skill
labenv lfm doctor; echo $?            # the lab's real agents, logins and models
mv defects.md x.md && labenv lfm doctor; echo $?   # fail source log, fix: check sources.log.path ...; exit 1
mv x.md defects.md && labenv lfm doctor; echo $?
```

Exit 0 needs a usable worker and a different judge that are logged in under the lab
HOME; a role that is not logged in there is a fail with its login command, which is
the correct answer for that HOME.

## Gotchas
A shim that reads `$HOME` (such as a wrapper that starts a mise node) fails `--version`
under a lab HOME, so that runner is not picked (a role pinned to it is a fail).
Never run the login probes against the captain's own HOME in a proof: use `labenv`.
