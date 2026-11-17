import { describe, it, expect, vi } from 'vitest';
import { DiscordSessionHealth } from '../src/web/discord-session-health.js';
import type { Session } from '../src/session.js';
const id = '11111111-1111-4111-8111-111111111111';
const conversation = '22222222-2222-4222-8222-222222222222';
function session(remote = true): Session {
  const value = {
    id,
    mode: 'codex',
    workingDir: '/work',
    muxName: 'codeman-test',
    nativeResumeId: conversation,
    claudeSessionId: conversation,
    remote: remote
      ? { hostId: 'worker', host: 'worker', label: 'worker', username: 'u', owned: true, remotePath: '/work' }
      : undefined,
    codexConfig: { resumeSessionId: conversation },
    isAdopted: false,
    paneLifecycleInFlight: false,
    pid: 42,
  };
  return {
    ...value,
    toState() {
      return { ...this };
    },
  } as unknown as Session;
}
it('separates a dead proxy from a living agent and never marks failed probes as Idle', async () => {
  const s = session();
  const remote = vi.fn().mockResolvedValue({ alive: true, agentRunning: true });
  const health = new DiscordSessionHealth({ paneExited: () => true, local: async () => 'dead', remote });
  expect(health.peek(s).state).toBe('connection_lost');
  expect((await health.check(s, true)).state).toBe('connection_lost');
  remote.mockResolvedValue(undefined);
  expect((await health.check(s, true)).state).toBe('unverified');
  expect(health.peek(s).state).toBe('unverified');
});
it('offers exact resume only for an absent owned agent with a known pin and exited proxy', async () => {
  const s = session();
  const health = new DiscordSessionHealth({
    paneExited: () => true,
    local: async () => 'dead',
    remote: async () => ({ alive: false, agentRunning: false }),
  });
  expect(await health.check(s, true)).toEqual({ state: 'agent_exited', canResume: true });
  Object.assign(s, { nativeResumeId: null, codexConfig: {} });
  expect(await health.check(s, true)).toEqual({ state: 'agent_exited', canResume: false });
});
it.each(['adopted', 'opaque', 'retained', 'live_proxy'])('does not offer resume for %s', async (kind) => {
  const s = session();
  if (kind === 'adopted') Object.assign(s, { remote: { ...s.remote, owned: false } });
  if (kind === 'opaque') Object.assign(s, { remote: { ...s.remote, commands: { codex: 'custom-wrapper' } } });
  const health = new DiscordSessionHealth({
    paneExited: () => true,
    local: async () => (kind === 'live_proxy' ? 'alive' : 'dead'),
    remote: async () => ({ alive: kind === 'retained', agentRunning: false }),
  });
  expect((await health.check(s, true)).canResume).toBe(false);
});
it('rejects a result whose pinned conversation changes during the read', async () => {
  const s = session();
  const health = new DiscordSessionHealth({
    paneExited: () => true,
    local: async () => 'dead',
    remote: async () => {
      Object.assign(s, { nativeResumeId: id });
      return { alive: false, agentRunning: false };
    },
  });
  expect(await health.check(s, true)).toEqual({ state: 'unverified' });
});
it('keeps local exits separate from Docker connection failures and rejects unreadable panes', async () => {
  const local = session(false);
  const health = new DiscordSessionHealth({ paneExited: () => true, local: async () => 'dead' });
  expect((await health.check(local, true)).state).toBe('agent_exited');
  Object.assign(local, { docker: {} });
  expect((await health.check(local, true)).state).toBe('connection_lost');
  const unknown = new DiscordSessionHealth({ paneExited: () => false, local: async () => 'unknown' });
  expect((await unknown.check(session(false), true)).state).toBe('unverified');
});
it('invalidates cached exit state after a new proxy is observed and fences a relaunch in flight', async () => {
  let exited = true;
  const s = session();
  const health = new DiscordSessionHealth({
    paneExited: () => exited,
    local: async () => 'dead',
    remote: async () => ({ alive: false, agentRunning: false }),
  });
  await health.check(s, true);
  exited = false;
  expect(health.peek(s).state).toBe('available');
  Object.assign(s, { paneLifecycleInFlight: true });
  expect(health.peek(s).state).toBe('unverified');
});

it('keeps a living agent unverified when its pinned conversation/profile cannot be validated', async () => {
  const health = new DiscordSessionHealth({
    paneExited: () => false,
    local: async () => 'alive',
    remote: async () => ({ alive: true, agentRunning: true }),
    verify: async () => false,
  });
  expect(await health.check(session(), true)).toEqual({ state: 'unverified' });
});
it('coalesces concurrent checks and keeps background polls responsive during a slow host read', async () => {
  let release!: (value: { alive: boolean; agentRunning: boolean }) => void;
  const gate = new Promise<{ alive: boolean; agentRunning: boolean }>((r) => {
    release = r;
  });
  const remote = vi.fn(() => gate),
    s = session();
  const health = new DiscordSessionHealth({ paneExited: () => true, local: async () => 'dead', remote });
  const first = health.check(s, true),
    second = health.check(s, true);
  expect(first).toBe(second);
  expect((await health.check(s)).state).toBe('connection_lost');
  release({ alive: false, agentRunning: false });
  await first;
  expect(remote).toHaveBeenCalledTimes(1);
});

it('retries a transient history failure before declaring a living agent unverified', async () => {
  const verify = vi.fn().mockRejectedValueOnce(new Error('transient read')).mockResolvedValue(true);
  const health = new DiscordSessionHealth({
    paneExited: () => false,
    local: async () => 'alive',
    remote: async () => ({ alive: true, agentRunning: true }),
    verify,
  });
  expect(await health.check(session(), true)).toEqual({ state: 'available' });
  expect(verify).toHaveBeenCalledTimes(2);
});
it('keeps a repeatedly failing verification unverified after a bounded retry', async () => {
  const verify = vi.fn().mockResolvedValue(false);
  const health = new DiscordSessionHealth({
    paneExited: () => false,
    local: async () => 'alive',
    remote: async () => ({ alive: true, agentRunning: true }),
    verify,
  });
  expect(await health.check(session(), true)).toEqual({ state: 'unverified' });
  expect(verify).toHaveBeenCalledTimes(2);
});
