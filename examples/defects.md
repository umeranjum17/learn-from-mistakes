# Defect log

Format: `- [area] what happened -> impact -> action`.

## 2026-03-02

- [runner] The memory killer stopped the agent server at 09:10 and again at 14:40; every worker lost its session -> 2 h idle -> OPEN.
- [cache] Two workers wrote the shared build cache at once; the second failed with "cache is locked" -> one lane stalled 40 min.
- [gate] Review step failed: agent exited but its output pipe stayed open past the 5 s wait -> run failed, branch held.
- [docs] Added a rule: run the linter before every push -> FIXED.

## 2026-03-03

- [runner] Memory killer stopped the agent server at 03:05 while three builds ran in the same group -> 1 h blind.
- [runner] After the 03:05 restart, workers resumed in the main checkout instead of their own copies -> relaunched by hand.
- [cache] Worker stopped mid-task on "cache is locked"; needed a manual nudge.
- [cache] Same 03-03 stall as above: the cache lock was held for 11 s against a 5 s timeout.
- [editor] The editor's own index said "database is locked" in its status bar; no work stopped.

## 2026-03-04

- [runner] The memory killer stopped the agent server at 21:50 -> nobody alerted for 4 h.
- [cache] Three workers stalled on "cache is locked" within 20 minutes.
- [gate] Same wait-delay failure on a test step -> run failed.
- [pulse] 2 merges in 2 h; 5 lanes working.
