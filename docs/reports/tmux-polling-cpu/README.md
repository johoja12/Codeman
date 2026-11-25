# Tmux polling CPU benchmark (#315)

Run `node scripts/benchmark-tmux-polling.mjs` after `npm run build` on Linux with at least 16 existing managed panes. The benchmark only reads panes on the instance-selected tmux socket. It suppresses pane text, native identities, and process arguments. `VITEST` is set within the benchmark process to skip manager state initialization; the injected executor performs read-only real tmux commands.

Three alternating before/after rounds on beelink, 2026-11-25, are recorded in `benchmark.json`. Each inventory round requests status and geometry for 16 sessions together. The old path launches 32 shell-wrapped tmux queries; the new path launches one shell-free all-pane inventory, filtered to the active window and active pane for status. Median combined Node plus reaped-helper CPU fell from 402.02 ms to 14.92 ms. Helper measurements use Linux clock ticks, so a zero value means below tick resolution rather than no helper CPU.

A second workload adds two simultaneous plain-frame requests per session: 64 commands before, 17 after; median combined CPU 820.99 ms before, 170.68 ms after. This demonstrates queued duplicate sharing, not the frequency of duplicate reads in production. Real mouse and reconnect watcher tests separately establish that their 16-session ticks use one inventory command each.

There is no completed or running snapshot cache and no polling interval increase. Only reads queued before dispatch are coalesced; later reads, failures and pane replacement are fresh. Signal-bearing captures remain exclusive so cancellation cannot affect a different consumer. Bookkeeping is bounded to 128 queued keys. Existing frame size limits, ANSI/plain separation, and timeouts remain in force. Inventory failures preserve the existing conservative false/empty return contract. A pane replacement during the reconnect inventory discards the watcher snapshot.

These are operation-level measurements against live panes, not whole-service CPU guarantees. Production measurements must exclude compiler/test/profiler load and HTTP stalls (#304), and must account for native session workload changes.
