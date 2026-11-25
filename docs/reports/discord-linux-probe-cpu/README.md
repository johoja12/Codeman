# Linux native profile probe CPU (#312)

The Linux Codex identity probe previously launched tmux plus three ps subprocesses, including a full-machine command listing. It now inspects only the exact pane's bounded process tree in procfs, including children created by worker threads. Process start ticks and exact NUL-delimited argv are checked before/after environment reads. No profile cache or polling delay is introduced; the portable ps path is retained.

## Reproduce

Build, then run `node scripts/benchmark-discord-runtime-probe.mjs <owned-local-session-UUID> [compiled-module-path]`. This performs five fresh read-only probes and verifies that the selected native identity/profile stays stable. It does not send terminal input or invoke a model. Output contains timings only, without raw argv, environment values, profile paths or native IDs. Wall time includes launching the Python process; CPU time includes that process and its reaped helper children.

Median of five reads of the same live session on beelink, under a changing production workload:

| Measurement               |    Before |     After |
| ------------------------- | --------: | --------: |
| Wall time per probe       | 290.93 ms | 135.23 ms |
| Combined probe/helper CPU | 263.08 ms | 109.54 ms |

This is about 58.4% less probe CPU. Whole-process savings depend on workload and probe frequency; these figures are not a long-term CPU guarantee. Fresh old/new read-only probes agreed on identity and profile for all four local pinned Codex sessions.

Synthetic procfs tests cover worker-thread children, unrelated agents, ambiguous ownership, exact argument boundaries, native PID/argv replacement during environment reads, pane replacement, inaccessible or malformed metadata, vanished children, strict environment handling, and depth/process/thread/metadata limits. Existing portable identity and environment fixtures continue exercising the ps path.
