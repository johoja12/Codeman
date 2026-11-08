/** Bounded, content-free bridge timings. CPU/heap context belongs to the entire Node process. */
import { performance } from 'node:perf_hooks';
import { captureDiscordProfile, discordProfileCaptureActive } from './discord-profile-capture.js';
export type DiscordProfileOperation =
  | 'history.local'
  | 'history.remote'
  | 'history.unknown'
  | 'poll.conversations'
  | 'poll.activity'
  | 'sync.sessions'
  | 'observe.conversation'
  | 'ui.poll'
  | 'ui.controls'
  | 'files.read'
  | 'files.write'
  | 'images.read'
  | 'control'
  | 'http.GET'
  | 'http.POST'
  | 'http.PATCH'
  | 'http.PUT'
  | 'http.DELETE'
  | 'http.other';
export type DiscordProfileCounter =
  | 'http.rateLimited'
  | 'http.serverError'
  | 'http.clientError'
  | 'poll.inFlight'
  | 'poll.notDue'
  | 'poll.remoteLimit'
  | 'poll.localLimit'
  | 'poll.noDestination';
interface Operation {
  calls: number;
  errors: number;
  active: number;
  peakActive: number;
  totalMs: number;
  maxMs: number;
  recent: number[];
  starts: Map<symbol, number>;
}
const RECENT_LIMIT = 128;
const round = (n: number) => Math.round(n * 100) / 100;
export class DiscordProfiling {
  private readonly started: number;
  private readonly cpuStart = process.cpuUsage();
  private readonly operations = new Map<DiscordProfileOperation, Operation>();
  private readonly counters = new Map<DiscordProfileCounter, number>();
  private lastCapture?: Awaited<ReturnType<typeof captureDiscordProfile>>;
  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = this.clock();
  }
  count(name: DiscordProfileCounter): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
  async measure<T>(name: DiscordProfileOperation, run: () => Promise<T>): Promise<T> {
    let op = this.operations.get(name);
    if (!op) {
      op = { calls: 0, errors: 0, active: 0, peakActive: 0, totalMs: 0, maxMs: 0, recent: [], starts: new Map() };
      this.operations.set(name, op);
    }
    const start = this.clock(),
      key = Symbol();
    op.calls++;
    op.active++;
    op.peakActive = Math.max(op.peakActive, op.active);
    if (op.starts.size < RECENT_LIMIT) op.starts.set(key, start);
    try {
      return await run();
    } catch (error) {
      op.errors++;
      throw error;
    } finally {
      const ms = Math.max(0, this.clock() - start);
      op.active--;
      op.starts.delete(key);
      op.totalMs += ms;
      op.maxMs = Math.max(op.maxMs, ms);
      if (op.recent.length === RECENT_LIMIT) op.recent.shift();
      op.recent.push(ms);
    }
  }
  async http(method: string, run: () => Promise<Response>): Promise<Response> {
    const name = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? method : 'other';
    return this.measure(`http.${name}` as DiscordProfileOperation, async () => {
      const response = await run();
      if (response.status === 429) this.count('http.rateLimited');
      else if (response.status >= 500) this.count('http.serverError');
      else if (response.status >= 400) this.count('http.clientError');
      return response;
    });
  }
  async capture(durationMs: number) {
    const result = await captureDiscordProfile(durationMs);
    this.lastCapture = result;
    return result;
  }
  snapshot() {
    const now = this.clock(),
      elapsedMs = Math.max(0, now - this.started),
      cpu = process.cpuUsage(this.cpuStart);
    const memory = process.memoryUsage();
    const operations = [...this.operations]
      .map(([name, op]) => {
        const recent = [...op.recent].sort((a, b) => a - b),
          completed = op.calls - op.active;
        return {
          name,
          calls: op.calls,
          completed,
          errors: op.errors,
          active: op.active,
          peakActive: op.peakActive,
          totalWallMs: round(op.totalMs),
          meanWallMs: round(completed ? op.totalMs / completed : 0),
          maxWallMs: round(op.maxMs),
          recentSamples: recent.length,
          recentP95WallMs: round(recent.length ? recent[Math.ceil(recent.length * 0.95) - 1] : 0),
          trackedActiveStarts: op.starts.size,
          oldestTrackedActiveMs: round(Math.max(0, ...[...op.starts.values()].map((start) => now - start))),
        };
      })
      .sort((a, b) => b.totalWallMs - a.totalWallMs);
    return {
      elapsedMs: round(elapsedMs),
      operations,
      counters: Object.fromEntries(this.counters),
      nodeProcessContext: {
        attribution: 'Entire Node process; not bridge-exclusive or SSH child CPU/memory',
        cpuUserMs: round(cpu.user / 1000),
        cpuSystemMs: round(cpu.system / 1000),
        meanCpuPercentOneCore: round(elapsedMs ? ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100 : 0),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBufferBytes: memory.arrayBuffers,
      },
      measurement: {
        duration:
          'Wall time includes I/O waits; nested/concurrent operation totals overlap and must not be summed as CPU',
        percentiles: 'Most recent 128 completed calls per operation',
        retention: 'In memory since bridge construction; no prompt, token, path, session ID or response text retained',
      },
      captureActive: discordProfileCaptureActive(),
      lastCapture: this.lastCapture,
    };
  }
}
