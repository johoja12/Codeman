# Discord history CPU optimization (#308)

Claude settings extraction hashed the entire encoded history packet for every assistant row. The parser already computes a SHA-256 digest for each native row; reusing it removes quadratic hashing and binds settings metadata to its correct stable cursor.

## Reproduce

Build the checkout, then run `node scripts/benchmark-discord-history.mjs`. An optional first argument selects another compiled `discord-history.js` for a baseline. Fixtures are synthetic; the benchmark reads no live conversation, calls no network service and sends no input. Each case warms once and reports the median of five runs. CPU time uses `process.cpuUsage`; wall time can vary with host load.

| Assistant rows | Packet bytes | Before wall ms | After wall ms | Before CPU ms | After CPU ms |
| -------------: | -----------: | -------------: | ------------: | ------------: | -----------: |
|             64 |        50118 |         10.777 |         3.009 |        11.819 |        3.303 |
|            512 |       401302 |        403.453 |        16.038 |       401.146 |       16.807 |
|           1536 |      1204830 |       4826.046 |         35.24 |      3885.016 |       35.149 |

The 1,536-row case improved about 137x in wall time and used about 99.1% less CPU. These are parser microbenchmarks, not a promise of equivalent whole-process savings.

The cursor regression fails before the change: reported settings must name the same native row as its visible turn and remain unchanged when unrelated rows are appended. History, catch-up, local/remote profile, native execution, model controls and UI service suites pass (155 tests). The generated-image profile-change test also fails on the unchanged baseline and is outside this parser change.
