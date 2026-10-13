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
- `agent`/`judge_agent` (the labels `worker`/`judge`): only the configured agents are checked (doctor never offers another one). The role resolves to a usable, offered agent (`resolveRoles`), with
  version and tools. A role that is not set is a fail (`agent is not set`) whose fix is the init save command
  (`learn-from-mistakes-axi init --agent <agent> --model <model> ... # with the user's answer`); the command asks first, as `init` does: in a terminal it saves the answer, otherwise it exits 2 with `error: ask the user which agent to use` and the same `next:` before any check.
  Any other role that does not resolve is a fail whose fix is `install <bin>, or set agent_path_override.<bin> in <global>` when the agent
  is not installed, else `ask the user which agent and model to use, then set agent and its agent_config model in <file>; the run never picks one` (usable but not offered, or a judge that
  clashes). `<file>` is the project file when it set the key, else the global file. A BYOKit route that failed its own check keeps its problem and fix.
- `worker login`/`judge login`: the agent's own status command through `which()`, its
  output never printed: `codex login status` (exit 0), `opencode auth list` (a
  credential or environment variable count above 0), `pi auth check --no-refresh
  --model <m>` (exit 0; with no model, the login file). A negative answer is a fail
  with the login command; a probe that does not finish in 20 s is a warn. pi is the one
  exception: a probe that fails for any reason (exit, error, signal, timeout) is checked
  against `~/.pi/agent/auth.json` by existence only: present is a warn with the exit code,
  absent is a fail with `pi # then /login`. Claude and Gemini: login file or key variable presence (warn
  when none: it may be in the keychain). The pi case warns the same way.
- `worker model`/`judge model`: a role with an agent but no `agent_config.<agent>.model` is not checked here: doctor stops
  before any check with the ask (exit 2, `agent_config.<agent>.model is not set`), as every command does, and an empty model
  is never acceptable, `allow_premium: true` included. A premium name (`opus`, `sonnet`, `sol`) is a fail unless
  `allow_premium: true` (its fix names both files).
- `judge`: a judge on the worker's identity (real binary, model) is a fail with the reason that it would judge its own
  work; fix: `ask the user which agent and model to use, then set judge_agent and its agent_config model in <file>; the run never picks one`. There is no separate identity line.
- `skill <runner>`: per configured, usable runner with a skills dir, `SKILL.md` under
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
`test/init.test.mjs` owns the journey: after `init` with the agents the user chose and fake `claude`, `opencode`,
`pi` and `gemini` (and `git`) on PATH, a synthetic Claude credential and fakes whose
login output carries a canary: exit 0 with the config, state, both sources, the worker,
both logins ok, and the skill for claude and sign-off as warns; then a missing
defect log, `agent: pi`, `judge_agent: pi` and `agent_config: { pi: { model: <premium model> } }` give
exactly 3 fails (`source log`, `worker model`, `judge`), each with `fix:`, exit 1
and `next: ... doctor   # again after the 4 fixes above`; the pi probe argv is
`auth check --no-refresh --model <premium model>`; the canary never prints; after the
fixes, exit 0. `doctor` with no agent set exits 2 with the ask, and stops on a BYOKit worker with no model with the ask for its model (exit 2, no call). The helper drives `doctor` (exit 0) and `doctor-missing-log` (exit 1,
`fix: check sources.log.path ...`) in its fresh init project with fake agents.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout, `$LAB` a
lab HOME holding only a link to the lab Claude credential; no agent call, no tokens):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && cp $SELF/examples/defects.md . && labenv lfm init --agent claude --model <the user's model> --judge-agent codex --judge-model <the user's model> --no-skill
labenv lfm doctor; echo $?            # the two chosen agents, their logins and models
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
