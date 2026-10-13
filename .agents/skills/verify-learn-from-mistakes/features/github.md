# GitHub PR source (`github` source)

## Sub-features
A `prs: { type: github }` source (no other key: the repo comes from `origin`) makes
`ingest` and `retro` read the pull requests merged in the read range from the
GitHub repo the project's git `origin` names (https, ssh or scp form; a GitHub
Enterprise host is passed to gh as `--hostname`). It runs the user's own `gh`, found on an
absolute PATH entry: one `gh api graphql` query (`src/sources/github.mjs`), newest update
first, 50 PRs a page, and it stops at the first page whose last PR was updated before the
read range; a PR met on two pages counts once. Each PR is one `records` row: `ts` its merge time, `ref` `PR #N`,
`text` its title and body after `redact()` (empty with `excerpts: off`), and `data` (JSON, the `records` table's `data` column)
with `bot`, `hours`, `rework_ci`, `rework_other`, `reverted`, `escaped`,
`partial` (over 100 commits: the first 100 are read), `labels` and `changes_requested`.
A commit authored after the PR opened is rework: CI rework when the commit before it had a
failing or erroring check rollup, else other rework. A commit with more than one parent (a base-branch
merge, such as GitHub's "Update branch") is not rework, and the commit before is the nearest earlier single-parent commit. A later merged PR whose title starts with
`Revert`, `Reverts` or `Reverted` and names `#N` (title or body) reverts PR N; a later merged PR whose title starts with `fix`, `fixes` or `fixed` (so `fix:`
and `fix(scope):` too, never `Fixture`) and names `#N` is an escape from it. A name is a bare `#N` or
this repo's `owner/name#N`: `#110` never names `#11`, and another repo's `#N` (`other-org/lib#5`) never names PR N.
Its numbers over the PRs merged in each window ([metrics.md](metrics.md)): `merged`;
`first_pass` (100 × people's merged PRs with no rework, not reverted, not escaped ÷ people's
merged PRs; bots are left out); `p50_hours_to_merge` and `p90_hours_to_merge` (nearest rank,
2 decimals); `rework_ci`, `rework_other`, `reverted`, `escaped` (sums). With no github source
they are `n/a`; with one and no merged PR, `merged` is 0 and the ratios and sums are `n/a`.
`init` writes `prs: { type: "github" }` when `origin` is on GitHub and `gh auth status`
passes; with `gh` missing or logged out it lists the source under `skipped` with the fix.
A missing `gh`, a logged-out `gh`, a failed query or a non-GitHub origin fail the source
with a usage error whose `next:` starts with `remove sources.<id> from .learn-from-mistakes.yaml`;
the origin URL is never printed (it can hold a token). A second github source is rejected. `doctor()` returns the PR count in
the window and the partial ones; `doctor` reports them through that hook.

## How to get to it (user POV)
In a clone of a GitHub repo with `gh auth login` done: `learn-from-mistakes-axi init`, or add
`prs: { type: github }` under `sources:`, then `learn-from-mistakes-axi retro --window 30d --foreground`.

## Driving it with the public CLI
`test/github.test.mjs` owns the journeys. PATH holds a fake `gh` (it logs its argv and
answers with two GraphQL pages the test writes), git and two fake agent CLIs; no call
reaches GitHub. `init` writes the source after one `gh auth status`; the retro reads 13 PRs
in two `gh api graphql` calls (no third page; one PR on both pages counts once), and gives
`merged` 10/3, `first_pass` 77.8/33.3, `p50_hours_to_merge` 1/5, `p90_hours_to_merge` 5/10,
`rework_ci` 1/0, `rework_other` 1/0, `reverted` 1/1, `escaped` 1/1 (current/previous; `Fixes #12`
and `Reverted #3` count, `Fixture update` naming `#10` does not); a planted token in a PR body
is `[redacted]` in the store and absent from the output; a 150-commit PR is `partial`; a
second retro with `excerpts: off` stores no PR title or body. The
second journey: logged out (exit 4) and missing `gh` exit 2 with the fix, `init` lists the
missing `gh` under `skipped`, and a non-GitHub origin with a token in its URL exits 2
without printing the token. `test/cli.test.mjs` rejects an unknown key (`repo`) on the source and a second github source.

Real-product proof (outside the repo; `$SCR` scratch, `$SELF` this checkout; real `gh`,
read-only):

```sh
lfm() { node "$SELF/bin/learn-from-mistakes-axi.mjs" "$@"; }
cd $SCR/ky && printf 'sources:\n  prs: { type: github }\n' > .learn-from-mistakes.yaml
lfm retro --window 30d --foreground
sqlite3 -readonly .lfm/lfm.sqlite "select window,name,value from metrics where name in ('merged','first_pass','p90_hours_to_merge')"
```

On `$SELF`: a scratch clone (`git clone --depth 1 <origin> $SCR/self`) with the same config
and commands. Numbers only; never paste PR text into evidence.

## Gotchas
"Commits after open" uses each commit's authored date, so a commit authored before the PR
opened but pushed after it is not rework. Hours to merge include bot PRs; `first_pass` does
not. A PR with more than 100 commits is read from its first 100 (`partial`). The read asks
GitHub for every PR updated in the range, so a large window on a busy repo takes several pages.
