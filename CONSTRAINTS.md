# Constraints

## Floor (blocking)

- No new suppression comments (`@ts-ignore`, `eslint-disable`, `noqa`, `type: ignore`).
- No unimplemented stubs or empty catches that hide failures.
- No skipped or deleted tests without a reason in the commit message.
- No secrets, private source records or private evidence in source control.
- Never weaken this floor to make a change pass.

## Check

At task end, inspect the complete candidate diff against its base for these five
rules, then run the existing `npm test` integration/e2e journeys and the project
verification skill. Report any violation as blocking; don't silently waive it.
This is a written floor contract, not a new CI/security/coverage tool installation.
No additional dimensions or thresholds are adopted in this one-time setup.
