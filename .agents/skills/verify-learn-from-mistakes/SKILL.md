---
name: verify-learn-from-mistakes
description: Drive the real lfm ingest/count/report CLI, reuse its e2e journeys, and retain private identity, input hashes, command logs and results before a PR or after CLI changes.
---

# Verify learn-from-mistakes

## Launch and doctor

Read `CONSTRAINTS.md`. Requires Node >=22.13 (`node --version`, not a server).
From the candidate checkout, install the locked dependency with `npm ci` if needed;
use an owned temporary HOME, XDG directories, TMPDIR and npm cache outside the repo.
Keep the install command, output and exit in the caller's private evidence folder.
Do not use the globally linked `lfm`: the helper runs this checkout's `bin/lfm.mjs`.
Doctor: `git status --short`, `git rev-parse HEAD`, `node --version`, `npm ls @toon-format/toon yaml`.
A missing dependency or runtime is a failed prerequisite, not a passing proof.

## Drive (synthetic default)

Caller supplies a stable, absolute, new or empty **private** evidence directory.
Never place it in the checkout, a source directory, or a public attachment/upload.
The helper rejects overlaps (including symlinked parents) and existing nonempty
folders before writing. It creates mode-0700 evidence and an isolated temporary
HOME/XDG/TMPDIR, runs the existing `npm test` journeys, then the public CLI on copies
of `examples`. Originals are hashed before and after; scratch is removed even
when a CLI check fails. No model, network, pipeline, or release is started by the
default journey. It also drives `--help`, `--version`, the bare command, `--json`
and `--full`, decodes the default TOON to prove it equals the `--json`
`lfm-report.v1` projection, and injects a private canary into a staged label and
proposal to prove it never reaches default, `--json`, `--full` or stderr.

```sh
node .agents/skills/verify-learn-from-mistakes/verify.mjs /absolute/private/evidence/cli
```

Pass `--package` to add the packaged-install journey: `npm pack` into the
evidence dir, assert the tarball manifest carries the bin, package metadata and
the standalone skill (and not `test`/`examples`), install that exact tarball into
a fresh prefix, and drive the installed `lfm` bin. This one step resolves the
declared npm dependencies, so it uses the isolated npm cache and may touch
the registry; the default journey does not.

```sh
node .agents/skills/verify-learn-from-mistakes/verify.mjs /absolute/private/evidence/cli --package
```

Read `commands.json`, both input manifests, `result.json`, `canary.json`,
`pack.json`/`pack.manifest.txt` (with `--package`) and each stdout/stderr.
All command exits must be 0, all `npm test` journeys must pass, input SHA256
manifests must match, and the mapped observations below must be present. A printed
helper success only proves command exits plus unchanged inputs; inspect the output.

## Explicit opt-in private source journey

Run the synthetic default first. Only with caller authorization naming a project
and label/proposal files, use a **different** new private evidence directory:

```sh
node .agents/skills/verify-learn-from-mistakes/verify.mjs /absolute/private/evidence/private-cli \
  --private /approved/project /approved/labels.jsonl /approved/proposals.jsonl
```

This reads the project `.learn-from-mistakes.yaml`, resolves source paths against
that project (and `~` against the caller's home), copies sources/labels/proposals,
and forces a safe state name in the copied config. It never labels automatically
or writes originals. Use quiescent SQLite snapshots without WAL/SHM/journal
sidecars; don't stop a shared writer to obtain them. Capture private baselines
(expected per-source items, incidents/duplicates/occurrences and coverage) before
running; compare actual count/report to those baselines, not synthetic numbers.
Bad labels/proposals or empty input cause failure; preserve logs and report the
real exit rather than weakening expectations. Do not print private report bodies,
paths, labels or hashes into a public PR; only publish a sanitized verdict.
Private data is never a repo fixture. A private run is optional, never implied.

## Evidence and trusted instruction consumption

`identity.json` records checkout path, exact Git HEAD/dirty status, runtime, candidate
hashes, resolved source paths and SHA256 identities (including SQLite, not just
its CLI mtime). `commands.json` records argv/cwd/exits; named stdout/stderr files
record actions and results; `state/state/verification/` retains ingest artifacts.
`inputs.before.json`, `inputs.after.json` and `result.json` prove read-only inputs.
Review evidence is terminal output, not a screenshot/theme/viewport matrix: this
app is a short-lived CLI. Record limitations and PASS/FAIL per mapped journey.

`.no-mistakes.yaml` uses the installed tool's multiline-string `test.instructions`
schema to tell its Test evidence agent to read this skill. In no-mistakes v1.79.0,
that text is injected **only from the trusted default branch**. `ci-workflow` in an
owned disposable Git fixture can prove parser acceptance, but does not prove
prompt delivery or that the agent read the skill. Inspect the actual emitted Test
prompt/agent logs when authorized; until then report **trusted consumption not
proven**, especially before this config merges. Never start a pipeline, publish
or change trust policy merely to prove configuration adoption.

## Cleanup and maintenance

The helper removes only its own `scratch/`; retain logs, state and manifests.
Remove only the temporary install HOME/cache you created, never existing tools or
credentials. No daemon is launched, so none needs stopping. Do not clean evidence.
Update this skill and its [feature map](features/README.md) with
`/maintain-verification-skill` monthly or after a large feature; verification setup
is separate from feature work.
