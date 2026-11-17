import { expect, it } from 'vitest';
import { DiscordProfiling } from '../src/discord-profiling.js';
import {
  summarizeDiscordCpu,
  summarizeDiscordAllocations,
  captureDiscordProfile,
  DiscordProfileBusy,
} from '../src/discord-profile-capture.js';
it('tracks overlapping waits and failures without summing them as exclusive CPU', async () => {
  let now = 0;
  const p = new DiscordProfiling(() => now);
  let release!: () => void;
  const waiting = p.measure(
    'history.remote',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  now = 40;
  const error = new Error('secret error body');
  await expect(
    p.measure('history.remote', async () => {
      now = 70;
      throw error;
    })
  ).rejects.toBe(error);
  let op = p.snapshot().operations[0];
  expect(op).toMatchObject({
    calls: 2,
    completed: 1,
    errors: 1,
    active: 1,
    peakActive: 2,
    oldestTrackedActiveMs: 70,
    totalWallMs: 30,
  });
  now = 100;
  release();
  await waiting;
  op = p.snapshot().operations[0];
  expect(op).toMatchObject({ active: 0, completed: 2, totalWallMs: 130, recentP95WallMs: 100 });
  expect(JSON.stringify(p.snapshot())).not.toContain('secret error body');
});
it('bounds recent samples and counts HTTP rate/transport errors without retaining URLs or payloads', async () => {
  let now = 0;
  const p = new DiscordProfiling(() => now);
  for (let i = 0; i < 500; i++)
    await p.measure('history.local', async () => {
      now += i;
    });
  expect(p.snapshot().operations[0].recentSamples).toBe(128);
  const rate = Response.json({ token: 'SECRET' }, { status: 429 });
  expect(await p.http('GET', async () => rate)).toBe(rate);
  await p.http('GET', async () => new Response('', { status: 503 }));
  await expect(
    p.http('GET', async () => {
      throw new Error('secret network details');
    })
  ).rejects.toThrow();
  expect(p.snapshot().counters).toMatchObject({ 'http.rateLimited': 1, 'http.serverError': 1 });
  expect(p.snapshot().operations.find((o) => o.name === 'http.GET')).toMatchObject({ calls: 3, errors: 1 });
  expect(JSON.stringify(p.snapshot())).not.toMatch(/SECRET|secret network details/);
});
const frame = (url: string, name = 'work') => ({
  functionName: name,
  url,
  scriptId: '1',
  lineNumber: 0,
  columnNumber: 0,
});
it('attributes nested CPU samples once to the closest bridge frame and never exports full paths', () => {
  const profile = {
    startTime: 0,
    endTime: 40,
    nodes: [
      { id: 1, callFrame: frame('', '(root)'), children: [2, 5, 6] },
      { id: 2, callFrame: frame('file:///private/user/discord-bridge.js', 'poll'), children: [3] },
      { id: 3, callFrame: frame('file:///private/user/discord-history.js', 'parse'), children: [4] },
      { id: 4, callFrame: frame('', 'JSON.parse') },
      { id: 5, callFrame: frame('', '(idle)') },
      { id: 6, callFrame: frame('file:///private/user/server.js', 'other') },
    ],
    samples: [4, 3, 5, 6],
    timeDeltas: [10, 10, 10, 10],
  };
  const result = summarizeDiscordCpu(profile);
  expect(result).toMatchObject({ activeSamples: 3, idleSamples: 1, bridgeSamples: 2, bridgeSampledMicros: 20 });
  expect(result.hotspots).toEqual([{ module: 'discord-history.js', function: 'parse', samples: 2, sampledMicros: 20 }]);
  expect(JSON.stringify(result)).not.toContain('/private/user');
});
it('separates sampled bridge allocations from other process allocations without double counting children', () => {
  const result = summarizeDiscordAllocations({
    head: {
      id: 1,
      callFrame: frame(''),
      selfSize: 10,
      children: [
        {
          id: 2,
          callFrame: frame('/private/discord-native-ui.js', 'render'),
          selfSize: 100,
          children: [{ id: 3, callFrame: frame('', 'Array'), selfSize: 200, children: [] }],
        },
        { id: 4, callFrame: frame('/private/server.js'), selfSize: 500, children: [] },
      ],
    },
    samples: [],
  });
  expect(result).toMatchObject({ totalSampledBytes: 810, bridgeSampledBytes: 300 });
  expect(result.hotspots).toEqual([{ module: 'discord-native-ui.js', function: 'render', sampledBytes: 300 }]);
});
it('captures a real bounded sample, rejects concurrent captures and disconnects for the next capture', async () => {
  const running = captureDiscordProfile(1000);
  await expect(captureDiscordProfile(1000)).rejects.toBeInstanceOf(DiscordProfileBusy);
  const sample = await running;
  expect(sample.elapsedMs).toBeGreaterThanOrEqual(900);
  expect(sample.cpu.activeSamples + sample.cpu.idleSamples).toBeGreaterThan(0);
  expect(sample.allocations.totalSampledBytes).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(sample)).not.toContain('callFrame');
  await expect(captureDiscordProfile(999)).rejects.toThrow('duration');
  const metrics = new DiscordProfiling();
  await expect(metrics.capture(1000)).resolves.toHaveProperty('cpu');
  expect(metrics.snapshot().lastCapture).toHaveProperty('cpu');
  expect(metrics.snapshot().captureActive).toBe(false);
}, 10000);

it('caps active-start telemetry even when many operations overlap', async () => {
  const p = new DiscordProfiling();
  const releases: Array<() => void> = [];
  const pending = Array.from({ length: 300 }, () =>
    p.measure('history.remote', () => new Promise<void>((resolve) => releases.push(resolve)))
  );
  expect(p.snapshot().operations[0]).toMatchObject({ active: 300, trackedActiveStarts: 128 });
  releases.forEach((resolve) => resolve());
  await Promise.all(pending);
  expect(p.snapshot().operations[0]).toMatchObject({ active: 0, trackedActiveStarts: 0, recentSamples: 128 });
});
