#!/usr/bin/env node
/** Read-only local native-profile benchmark. No terminal input, model calls or raw environment output.
 * node scripts/benchmark-discord-runtime-probe.mjs <session UUID> [compiled module path]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const session = process.argv[2];
assert(
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session ?? ''),
  'Supply the UUID of an owned, running local Codex session'
);
const moduleUrl = process.argv[3]
  ? pathToFileURL(resolve(process.argv[3]))
  : new URL('../dist/discord-remote-conversation.js', import.meta.url);
const { REMOTE_CODEX_RUNTIME_PROBE } = await import(moduleUrl.href);
const { resolveTmuxSocketName } = await import(new URL('../dist/config/instance.js', import.meta.url).href);
const run = promisify(execFile),
  samples = [];
let identity;
for (let i = 0; i < 5; i++) {
  const wrapper = `import time,resource,contextlib,io,json
_bench_start=time.perf_counter();_bench_output=io.StringIO()
with contextlib.redirect_stdout(_bench_output):
 exec(${JSON.stringify(REMOTE_CODEX_RUNTIME_PROBE)})
_bench_own=resource.getrusage(resource.RUSAGE_SELF);_bench_child=resource.getrusage(resource.RUSAGE_CHILDREN)
_bench_value=json.loads(_bench_output.getvalue())
print(json.dumps({'elapsedMs':(time.perf_counter()-_bench_start)*1000,'selfCpuMs':(_bench_own.ru_utime+_bench_own.ru_stime)*1000,'childCpuMs':(_bench_child.ru_utime+_bench_child.ru_stime)*1000,'identity':[_bench_value.get('id'),_bench_value.get('configHome')]}))
`;
  const started = performance.now();
  const response = await run(
    'python3',
    [
      '-c',
      wrapper,
      JSON.stringify({ location: { socket: resolveTmuxSocketName(), sessionName: 'codeman-' + session.slice(0, 8) } }),
    ],
    { timeout: 20000, maxBuffer: 65536 }
  );
  const value = JSON.parse(response.stdout);
  assert(value.identity[1], 'Exact native runtime was not verified');
  identity ??= value.identity;
  assert.deepEqual(value.identity, identity, 'Runtime identity changed during the benchmark');
  samples.push({
    elapsedMs: performance.now() - started,
    selfCpuMs: value.selfCpuMs,
    childCpuMs: value.childCpuMs,
    totalCpuMs: value.selfCpuMs + value.childCpuMs,
  });
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
  JSON.stringify(
    {
      benchmark: 'read-only exact local Codex profile',
      runs: samples.length,
      identityStable: true,
      medianWallMs: median(samples.map((s) => s.elapsedMs)),
      medianTotalCpuMs: median(samples.map((s) => s.totalCpuMs)),
      samples,
    },
    null,
    2
  )
);
