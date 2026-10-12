# doctor (`doctor`)

## Sub-features
`src/doctor.mjs` prints one line per check, `ok|warn|fail <label> <detail>`, and an
indented `fix: <command or edit>` under each line that is not ok; `--json` prints
`{ checks: [{ level, label, detail, fix? }], fails }`. Any `fail` exits 1, else 0.
It only reads: no state dir is made, no agent is called (unless `--live`).

Checks, in order:
- `node`: Node >= 22.13 (fail).
- `git`: a git repo (warn: worktree sessions are not matched; fix `git -C <dir> init`).
- `config`: `.learn-from-mistakes.yaml` loads (fail, then no more checks; fix `init`
  when there is none, else edit the file).
- `state`: `.lfm` is git-ignored (fail, fix `init`); ok when no `.lfm/.gitignore`
  exists yet (the first run writes it) or `state_root` moves it out of the project.
- `source <id>`: each source's registry `doctor()` hook (sessions: stores, sessions and
  skipped records), else a read with the item count and the count in the window. A read
  error is a fail with the source's own fix (a missing defect log: `touch <path>   # or set
  sources.<id>.path ...`). No sources at all: warn.
- `agent <runner>`: each runner binary found; one that is not offered (gemini, acp) or
  whose `--version` fails is a warn with its reason, never a fail.
- `worker`/`judge`: the role resolves to a usable, offered runner (`resolveRoles`), with
  version and tools; a role pinned to a not-offered runner is a warn, any other
  unresolved role a fail.
- `worker login`/`judge login`: the agent's own status command through `which()`, its
  output never printed: `codex login status` (exit 0), `opencode auth list` (a
  credential or environment variable count above 0), `pi auth check --no-refresh
  --model <m>` (exit 0; with no model, the login file). A negative answer is a fail
  with the login command; a probe that does not finish in 20 s is a warn. Claude and
  Gemini: login file or key variable presence (warn when none: it may be in the keychain).
- `worker model`/`judge model`: no model and no `models.json` default is a warn; a
  premium name (`opus`, `sonnet`, `sol`) is a fail unless `allow_premium: true`
  (`LFM_MODEL` is named, and `unset LFM_MODEL` is in the fix).
- `identity`: the worker's and judge's (real binary, model) differ (fail: the judge
  would judge its own work; fix: another agent CLI or a different judge model).
- `skill <runner>`: per usable runner with a skills dir, `SKILL.md` under
  `learn-from-mistakes/` in its global dir (`${CLAUDE_CONFIG_DIR:-~/.claude}/skills`,
  `${CODEX_HOME:-~/.codex}/skills`, `${XDG_CONFIG_HOME:-~/.config}/opencode/skills`,
  `~/.pi/agent/skills`, `~/.gemini/skills`) or the project's `.claude/skills` or
  `.agents/skills` (warn; fix: copy the packaged `SKILL.md` there).
- `sign-off`: `sign-off` on PATH, or `signoff: off` (warn: plain-text fallback).
- `--live`: `worker live`/`judge live`, one `agents --test` call per resolved role with
  its own model (costs tokens): it must answer and write no file.

## How to get to it (user POV)
`learn-from-mistakes-axi doctor` in a project dir (or `--dir <project>`), after `init`.

## Driving it with the public CLI
`test/init.test.mjs` owns the journey: after `init` with fake `claude`, `opencode`,
`pi` and `gemini` (and `git`) on PATH, a synthetic Claude credential and fakes whose
login output carries a canary: exit 0 with the config, state, sources, roles, logins
and identity ok and gemini, a skill and sign-off as warns; then a missing defect log,
`worker: { runner: pi, model: claude-opus-5-5 }` and `judge: { runner: pi }` give
exactly 3 fails (`source log`, `worker model`, `identity`), each with `fix:`, exit 1
and `next: ... doctor   # again after the 3 fixes above`; the pi probe argv is
`auth check --no-refresh --model claude-opus-5-5`; the canary never prints; after the
fixes, exit 0. The helper drives `doctor` (exit 0) and `doctor-missing-log` (exit 1,
`fix: touch`) in its fresh init project with fake agents.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout, `$LAB` a
lab HOME holding only a link to the lab Claude credential; no agent call, no tokens):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
labenv() { HOME=$LAB CLAUDE_CONFIG_DIR=$LAB/.claude CODEX_HOME=$LAB/.codex XDG_CONFIG_HOME=$LAB/.config XDG_DATA_HOME=$LAB/.local/share "$@"; }
cd $SCR/ky && cp $SELF/examples/defects.md . && labenv lfm init -y --no-skill
labenv lfm doctor; echo $?            # the lab's real agents, logins and models
mv defects.md x.md && labenv lfm doctor; echo $?   # fail source log, fix: touch ...; exit 1
mv x.md defects.md && labenv lfm doctor; echo $?
```

Exit 0 needs a usable worker and a different judge that are logged in under the lab
HOME; a role that is not logged in there is a fail with its login command, which is
the correct answer for that HOME.

## Gotchas
A shim that reads `$HOME` (such as a wrapper that starts a mise node) fails `--version`
under a lab HOME, so that runner is a warn `agent <runner>` and is not picked.
Never run the login probes against the captain's own HOME in a proof: use `labenv`.
