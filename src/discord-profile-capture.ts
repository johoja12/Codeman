/** Opt-in bounded V8 sampling. No inspector port, debugger pause, raw profile export or heap snapshot. */
import type { Session, Profiler, HeapProfiler } from 'node:inspector';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
let capturing = false;
export function discordProfileCaptureActive(): boolean {
  return capturing;
}
export class DiscordProfileBusy extends Error {}
const bridgeModule = (path: string): string | undefined => {
  const module = path.split(/[\\/]/).at(-1)?.replace(/\?.*$/, '');
  return module && /^discord-[a-z0-9-]+\.(?:js|ts)$/.test(module) && !/^discord-profil/.test(module)
    ? module
    : undefined;
};
const safeFunction = (name: string) => name.replace(/[^a-zA-Z0-9_.$ <>:-]/g, '').slice(0, 80) || '(anonymous)';
/** Count each sample/self-allocation once, under the closest bridge frame on its stack. */
export function summarizeDiscordCpu(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parents = new Map<number, number>();
  for (const n of profile.nodes) for (const child of n.children ?? []) parents.set(child, n.id);
  const grouped = new Map<string, { module: string; function: string; samples: number; sampledMicros: number }>();
  let activeSamples = 0,
    bridgeSamples = 0,
    idleSamples = 0,
    totalSampledMicros = 0,
    bridgeSampledMicros = 0;
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const leaf = nodes.get(profile.samples![i]);
    if (!leaf) continue;
    const micros = Math.max(0, profile.timeDeltas?.[i] ?? 0);
    totalSampledMicros += micros;
    if (leaf.callFrame.functionName === '(idle)') {
      idleSamples++;
      continue;
    }
    activeSamples++;
    let current: number | undefined = leaf.id,
      owner: { module: string; function: string } | undefined;
    const visited = new Set<number>();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const n = nodes.get(current);
      if (!n) break;
      const module = bridgeModule(n.callFrame.url);
      if (module) {
        owner = { module, function: safeFunction(n.callFrame.functionName) };
        break;
      }
      current = parents.get(current);
    }
    if (!owner) continue;
    bridgeSamples++;
    bridgeSampledMicros += micros;
    const key = owner.module + ':' + owner.function;
    const entry = grouped.get(key) ?? { ...owner, samples: 0, sampledMicros: 0 };
    entry.samples++;
    entry.sampledMicros += micros;
    grouped.set(key, entry);
  }
  return {
    activeSamples,
    idleSamples,
    bridgeSamples,
    totalSampledMicros,
    bridgeSampledMicros,
    bridgeShareOfActiveSamplesPercent: activeSamples ? Math.round((bridgeSamples / activeSamples) * 10000) / 100 : 0,
    hotspots: [...grouped.values()].sort((a, b) => b.sampledMicros - a.sampledMicros).slice(0, 20),
  };
}
export function summarizeDiscordAllocations(profile: HeapProfiler.SamplingHeapProfile) {
  const grouped = new Map<string, { module: string; function: string; sampledBytes: number }>();
  let totalSampledBytes = 0,
    bridgeSampledBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode, inherited?: { module: string; function: string }) => {
    const module = bridgeModule(node.callFrame.url),
      owner = module ? { module, function: safeFunction(node.callFrame.functionName) } : inherited;
    totalSampledBytes += node.selfSize;
    if (owner) {
      bridgeSampledBytes += node.selfSize;
      const key = owner.module + ':' + owner.function;
      const item = grouped.get(key) ?? { ...owner, sampledBytes: 0 };
      item.sampledBytes += node.selfSize;
      grouped.set(key, item);
    }
    for (const child of node.children) visit(child, owner);
  };
  visit(profile.head);
  return {
    totalSampledBytes,
    bridgeSampledBytes,
    hotspots: [...grouped.values()].sort((a, b) => b.sampledBytes - a.sampledBytes).slice(0, 20),
  };
}
export async function captureDiscordProfile(durationMs: number) {
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 15000)
    throw new Error('Capture duration must be 1000–15000 ms');
  if (capturing) throw new DiscordProfileBusy('A profile or inspector session is already active');
  capturing = true;
  let session: Session | undefined;
  let cpu = false,
    heap = false;
  const post = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) =>
      session!.post(method, params, (error, value) => (error ? reject(error) : resolve(value as T)))
    );
  const started = performance.now(),
    cpuStart = process.cpuUsage();
  try {
    const inspector = await import('node:inspector');
    if (inspector.url()) throw new DiscordProfileBusy('A profile or inspector session is already active');
    session = new inspector.Session();
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 1000 });
    await post('HeapProfiler.startSampling', { samplingInterval: 512 * 1024 });
    heap = true;
    await post('Profiler.start');
    cpu = true;
    await delay(durationMs);
    const sampled = await post<{ profile: Profiler.Profile }>('Profiler.stop');
    cpu = false;
    const allocated = await post<{ profile: HeapProfiler.SamplingHeapProfile }>('HeapProfiler.stopSampling');
    heap = false;
    const cpuDelta = process.cpuUsage(cpuStart);
    return {
      capturedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      processCpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
      cpu: summarizeDiscordCpu(sampled.profile),
      allocations: summarizeDiscordAllocations(allocated.profile),
      limitations: [
        'Stack samples are statistical inclusive attribution; shared async callbacks/native work may lack a bridge frame.',
        'Process CPU includes all Node work; SSH subprocess CPU is excluded.',
        'Sampled allocation bytes describe this capture window, not total bridge retained memory. Existing allocations and unsampled objects are excluded.',
        'Sampling adds overhead. No raw stack paths, arguments, prompt/response contents or heap objects are returned.',
      ],
    };
  } finally {
    if (cpu) await post('Profiler.stop').catch(() => undefined);
    if (heap) await post('HeapProfiler.stopSampling').catch(() => undefined);
    try {
      session?.disconnect();
    } finally {
      capturing = false;
    }
  }
}
