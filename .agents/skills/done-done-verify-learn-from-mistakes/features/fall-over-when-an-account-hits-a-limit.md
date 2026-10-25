# Fall over when an account hits a limit

Part of the learn-from-mistakes verification map. Source: `scripts/verify-journeys.mjs`.

## How to get to it (user POV)

Set `account_picker` (or `ACCOUNT_PICKER`) to an argv that speaks JSON protocol v1. Run a model call (`agents --test claude` or a retro). When the first account hits a quota, the same call continues on the next account.

## Driving it

Harness: A shell: the run is a single node command whose exit code and the files it writes in the evidence folder are the proof. No browser or terminal driver is needed.

1. Launch the app as SKILL.md says and wait until it is ready.
2. The cli journey's account-picker drive runs `agents --test claude` with the stub picker in `test/fake-agent/account-picker` and `FAKE_QUOTA_ON=pa_umer_a`. The call answers on account B. The picker log shows `next` with `attempted: ["pa_umer_a"]`. A credits selection is refused. The same command with no picker keeps today's shape (no `account` field).
3. Capture: account-picker.stdout, account-picker-credits.stderr, account-picker-unset.stdout.
4. Stop what you started.

The drive changes no repo file: note findings in the run's report; after the drive, run done-done maintain to see what drifted, then fix the skill.
