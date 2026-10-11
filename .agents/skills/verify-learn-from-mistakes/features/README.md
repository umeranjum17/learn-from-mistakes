# CLI feature map

| Feature | Public drive | Expected evidence |
| --- | --- | --- |
| [Ingest](ingest.md) | `lfm ingest` | source counts and retained state; input hashes unchanged |
| [Count](count.md) | `lfm count` before/after labels | separate source totals, duplicate/occurrence arithmetic, unread coverage |
| [Report and errors](report.md) | `lfm report`, existing negative journeys | real refs; bad input/empty exits, no fabricated coverage |

Run the helper from `../SKILL.md`; reuse `test/cli.test.mjs`, never duplicate its
journeys in a new test file. Synthetic expectations apply only to `examples`.
