/** Scheduler-only regressions: no Discord/network, native input, session attachment or state writes. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordBridge, DEFAULT_DISCORD_CONFIG } from '../src/discord-bridge.js';
const dirs: string[] = [];
const bridges: DiscordBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) b.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(count: number, kind: 'remote' | 'local' | 'mixed' = 'remote') {
  const dir = await mkdtemp(join(tmpdir(), 'discord-fair-poll-'));
  dirs.push(dir);
  let now = 100000;
  const sessions = Array.from({ length: count }, (_, i) => ({
    id: 's' + i,
    name: 'session ' + i,
    working: true,
    remote: kind === 'remote' || (kind === 'mixed' && i % 3 !== 0),
  }));
  const pending: Array<{ id: string; done: () => void }> = [];
  const seen = new Set<string>();
  const b = new DiscordBridge({
    configDir: dir,
    now: () => now,
    sessions: () => sessions,
    history: async () => ({ conversationId: 'test', turns: [] }),
    sendInput: async () => {
      throw new Error('No input allowed');
    },
    fetchImpl: async () => {
      throw new Error('No network allowed');
    },
  });
  bridges.push(b);
  const internals = b as unknown as {
    cfg: typeof DEFAULT_DISCORD_CONFIG;
    stopped: boolean;
    held: boolean;
    channels: { channelForSession: () => string };
    observeConversation: (id: string) => Promise<void>;
  };
  internals.cfg = { ...DEFAULT_DISCORD_CONFIG, enabled: true, mode: 'full' };
  internals.stopped = false;
  internals.held = false;
  internals.channels.channelForSession = () => 'test-channel';
  internals.observeConversation = (id) => {
    seen.add(id);
    return new Promise<void>((done) => pending.push({ id, done }));
  };
  async function tick() {
    const poll = b.pollConversations();
    await Promise.resolve();
    await Promise.resolve();
    const jobs = pending.splice(0);
    expect(jobs.filter((j) => sessions.find((s) => s.id === j.id)?.remote).length).toBeLessThanOrEqual(2);
    expect(jobs.filter((j) => !sessions.find((s) => s.id === j.id)?.remote).length).toBeLessThanOrEqual(4);
    for (const j of jobs) j.done();
    await poll;
    return jobs.map((j) => j.id);
  }
  return {
    b,
    sessions,
    pending,
    seen,
    tick,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it.each([8, 16, 24, 17])(
  'eventually reads every continuously eligible remote session at population %s',
  async (count) => {
    const f = await fixture(count);
    for (let i = 0; i < count; i++) {
      await f.tick();
      f.advance(20000);
    }
    expect(f.seen.size).toBe(count);
  }
);
it.each(['local', 'mixed'] as const)('preserves fairness and separate pool limits for %s sessions', async (kind) => {
  const f = await fixture(24, kind);
  for (let i = 0; i < 24; i++) {
    await f.tick();
    f.advance(20000);
  }
  expect(f.seen.size).toBe(24);
});
it('does not schedule duplicate concurrent reads or ignore cooldowns', async () => {
  const f = await fixture(3);
  const p = f.b.pollConversations();
  await Promise.resolve();
  await Promise.resolve();
  const pending = f.pending.splice(0);
  expect(pending).toHaveLength(2);
  for (let i = 0; i < 20; i++) expect(f.b.pollConversations()).toBe(p);
  expect(f.pending).toHaveLength(0);
  for (const j of pending) j.done();
  await p;
  f.advance(5000);
  const next = await f.tick();
  expect(next).toEqual(['s2']);
});
