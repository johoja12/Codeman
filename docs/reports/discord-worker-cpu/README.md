# Discord worker and transport CPU (#317, #318, #319)

Run `node scripts/benchmark-discord-workers.mjs dist` after building on Linux with existing managed panes and configured reachable SSH sessions. For source testing: `node --import tsx scripts/benchmark-discord-workers.mjs src`. The driver performs read-only captures, the unchanged native identity probe, and remote `true` commands. It does not export frames, native IDs, addresses, config homes, credentials or argv. Its `VITEST` environment skips incidental manager initialization; it exercises the real batcher/interpreter/pool classes directly.

Three alternating rounds on beelink, 2026-11-25, are in `benchmark.json`. There were 15 live panes; the 16-query frame workload includes an ANSI variant of one pane (not 16 separate production sessions). The unit fixture separately exercises 16 distinct panes. Combined CPU includes Node, reaped helper CPU and live direct Python children / known SSH masters from Linux process ticks, so very small helper costs are quantized. Interpreter/pool warmup precedes steady-state comparisons; SSH warmup is reported separately. No global service saving is implied.

| Workload | Before median wall / combined CPU | After median wall / combined CPU |
| --- | --- | --- |
| 16 visible-frame queries | 115.95 / 219.69 ms, 16 tmux clients | 55.67 / 66.25 ms, 4 clients |
| Exact local native runtime probe | 151.61 / 156.42 ms | 33.47 / 21.70 ms |
| Remote true, host 1 | 537.78 / 296.20 ms | 70.00 / 38.30 ms |
| Remote true, host 2 | 671.47 / 308.06 ms | 55.72 / 49.55 ms |

Transport reuse preserves the reader's 8MiB output / 64KiB stderr / 30s channel bounds, owner-object and full SSH-option separation, and explicit user control options. Pool bookkeeping is capped at 64 identities and idle masters expire after 60s; shutdown closes owned connections. Each channel still reads and validates fresh data.

Capture batches contain at most four requests and two active client processes, with a 4ms dispatch window, 64-request admission bound and 1500ms end-to-end request deadline. There is no stale frame cache. Each frame has a random delimiter; partial/malformed batches or missing panes are retried independently within original deadlines. Per-caller cancellation does not cancel other panes; all-consumer cancellation aborts only the shared read-only client.

Native inspection reuses at most two interpreters, compiled trusted probe code and imports. Each request executes in fresh globals with fresh argv and reads current process/argv/start-time/environment state. The original before/after history identity checks are retained. Requests and output are bounded, deadlines include queue time, failure kills only the owned helper, idle workers expire after 30s, and shutdown rejects pending work. Linux and portable probe logic itself is unchanged.
