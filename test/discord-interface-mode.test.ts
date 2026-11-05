/** Full-interface discovery uses fake Discord only; never attaches to or submits work to a session. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DISCORD_CONFIG,
  DiscordBridge,
  discordConfigPath,
  readDiscordConfig,
  writeDiscordConfig,
  type DiscordFetch,
} from '../src/discord-bridge.js';

const cfg = {
  ...DEFAULT_DISCORD_CONFIG,
  enabled: true,
  mode: 'full' as const,
  categoryId: '666666666666666666',
  onChannelDelete: 'delete' as const,
  token: 'fake-test-token',
  guildId: '111111111111111111',
  parentChannelId: '222222222222222222',
  allowedUserIds: ['333333333333333333'],
};
let dir: string;
let sessions: Array<{ id: string; name?: string }>;
let bridges: DiscordBridge[];
let posts: Array<{ path: string; method: string; body?: any }>;
let sendInput: ReturnType<typeof vi.fn>;
let sequence: number;
let remoteChannels: Map<string, any>;

function makeBridge(
  fetchOverride?: DiscordFetch,
  extra: Partial<import('../src/discord-bridge.js').DiscordBridgeDeps> = {}
) {
  const bridge = new DiscordBridge({
    configDir: dir,
    ...extra,
    sessions: () => sessions,
    sendInput,
    fetchImpl: async (url, init) => {
      const method = String(init.method);
      const path = url.pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      posts.push({ path, method, body } as any);
      if (method === 'GET' && path.endsWith('/channels')) return Response.json([...remoteChannels.values()]);
      if (method === 'GET')
        return Response.json(
          remoteChannels.get(path.split('/').pop()!) ?? { id: path.split('/').pop(), type: 4, guild_id: cfg.guildId }
        );
      if (method === 'POST' && path.endsWith('/channels')) {
        const result = fetchOverride
          ? await fetchOverride(url, init)
          : Response.json({ id: String(444444444444444440n + BigInt(sequence++)) });
        if (!result.ok) return result;
        const got = await result.json();
        const c = { ...body, id: got.id, guild_id: cfg.guildId };
        remoteChannels.set(c.id, c);
        return Response.json(c);
      }
      const id = path.split('/').pop()!;
      if (method === 'PATCH') Object.assign(remoteChannels.get(id) ?? {}, body);
      if (method === 'DELETE') remoteChannels.delete(id);
      return Response.json({ id: '444444444444444444' });
    },
    socketFactory: () => ({ send() {}, close() {}, on() {} }),
  });
  bridges.push(bridge);
  return bridge;
}
const creations = () => posts.filter((p) => p.method === 'POST' && p.path.endsWith('/channels'));
async function readFullMap(dir: string): Promise<Record<string, string>> {
  const raw = JSON.parse(await readFile(join(dir, 'discord-channels.json'), 'utf8').catch(() => '{}'));
  const current = await readDiscordConfig(dir);
  return Object.fromEntries(
    Object.values(raw.entries ?? {})
      .filter((e: any) => e.state === 'active' && e.categoryId === current.categoryId)
      .map((e: any) => [e.sessionId, e.channelId])
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-mode-'));
  sessions = [
    { id: 's1', name: 'w1-brain' },
    { id: 's2', name: 'w2-remote' },
  ];
  bridges = [];
  posts = [];
  sequence = 0;
  remoteChannels = new Map();
  sendInput = vi.fn(async () => true);
  await writeDiscordConfig(dir, cfg);
});
afterEach(async () => {
  for (const bridge of bridges) bridge.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('Discord interface mode', () => {
  it('routes a full-mode channel reply to its exact session and preserves it across mode changes', async () => {
    const b = makeBridge();
    await b.reload();
    await b.syncSessions();
    const original = await readFullMap(dir);
    await b.onGatewayMessage({
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: original.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: 'hello',
    });
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('s1', 'hello\r');
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await b.reload();
    await b.onGatewayMessage({
      id: '555555555555555556',
      guild_id: cfg.guildId,
      channel_id: original.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: 'old channel',
    });
    expect(sendInput).toHaveBeenCalledTimes(1);
    await writeDiscordConfig(dir, cfg);
    await b.reload();
    await b.syncSessions();
    expect(await readFullMap(dir)).toEqual(original);
    expect(creations()).toHaveLength(2);
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
  });
  it('serves a control without typing and deduplicates repeated/unauthorized gateway messages', async () => {
    const control = vi.fn(async () => ({ text: 'Working' }));
    const b = makeBridge(undefined, { control });
    await b.reload();
    await b.syncSessions();
    const map = await readFullMap(dir);
    const message = {
      id: '555555555555555555',
      guild_id: cfg.guildId,
      channel_id: map.s1,
      author: { id: cfg.allowedUserIds[0] },
      content: '!codeman status',
    };
    await b.onGatewayMessage(message);
    await b.onGatewayMessage(message);
    await b.onGatewayMessage({ ...message, id: '555555555555555556', author: { id: '999999999999999999' } });
    expect(control).toHaveBeenCalledExactlyOnceWith('s1', 'status');
    expect(sendInput).not.toHaveBeenCalled();
    expect(posts.some((p) => p.body?.content === 'Working')).toBe(true);
  });
  it('backfills bounded historical turns once across synchronization and process restart', async () => {
    const history = vi.fn(async () => ({
      conversationId: 'native1',
      partial: false,
      turns: Array.from({ length: 20 }, (_, i) => ({
        cursor: `native1:${i}:abc`,
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        text: 'historic ' + i,
        timestamp: '2026-01-01',
      })),
    }));
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    const historical = () => posts.filter((p) => p.body?.content?.startsWith('**Historical context**'));
    expect(historical()).toHaveLength(12);
    expect(historical()[0].body?.content).toContain('historic 14');
    expect(historical().every((p) => p.body?.allowed_mentions?.parse.length === 0)).toBe(true);
    await b.syncSessions();
    expect(historical()).toHaveLength(12);
    b.stop();
    const again = makeBridge(undefined, { history });
    await again.reload();
    await again.syncSessions();
    expect(historical()).toHaveLength(12);
    expect(sendInput).not.toHaveBeenCalled();
  });
  it('keeps other session channels available when one transcript is unavailable and retries without recreating destinations', async () => {
    let offline = true;
    const history = vi.fn(async (id: string) => {
      if (id === 's1' && offline) throw new Error('offline');
      return { conversationId: 'native1', partial: false, turns: [] };
    });
    const b = makeBridge(undefined, { history });
    await b.reload();
    await b.syncSessions();
    expect(creations()).toHaveLength(2);
    expect(b.sessionSync.failed).toBeGreaterThan(0);
    offline = false;
    await b.syncSessions();
    expect(creations()).toHaveLength(2);
    expect(b.sessionSync.state).toBe('complete');
  });
  it('streams new native responses once, edits task status and retains the boundary across restart', async () => {
    let now = 100000;
    let turns: import('../src/discord-history.js').DiscordHistoryTurn[] = [];
    let state: 'running' | 'completed' = 'running';
    const history = async () => ({
      conversationId: 'native1',
      partial: false,
      turns,
      executions: turns.length ? [{ userCursor: turns[0].cursor, promptHash: 'a'.repeat(64), state }] : [],
    });
    sessions = [{ id: 's1', name: 'one' }];
    const b = makeBridge(undefined, { history, now: () => now });
    await b.reload();
    await b.syncSessions();
    turns = [
      { cursor: 'native1:1:abc', role: 'user', text: 'question', timestamp: 't' },
      { cursor: 'native1:2:abc', role: 'assistant', text: 'fresh answer', timestamp: 't' },
    ];
    await b.pollConversations();
    const answers = () => posts.filter((p) => p.body?.content?.includes('fresh answer'));
    expect(answers()).toHaveLength(1);
    expect(posts.some((p) => p.body?.content === 'Latest native task: **running**')).toBe(true);
    now += 60001;
    state = 'completed';
    await b.pollConversations();
    expect(answers()).toHaveLength(1);
    expect(posts.some((p) => p.method === 'PATCH' && p.body?.content === 'Latest native task: **completed**')).toBe(
      true
    );
    b.stop();
    const again = makeBridge(undefined, { history, now: () => now });
    await again.reload();
    await again.syncSessions();
    await again.pollConversations();
    expect(answers()).toHaveLength(1);
    expect(sendInput).not.toHaveBeenCalled();
  });
  it('defaults legacy and unknown config values to notifications', async () => {
    for (const mode of [undefined, 'unknown', null]) {
      await writeFile(discordConfigPath(dir), JSON.stringify({ enabled: false, mode }));
      expect((await readDiscordConfig(dir)).mode).toBe('notifications');
    }
  });

  it('leaves legacy lazy notification discovery unchanged', async () => {
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    await bridge.sessionCreated('s3', 'new');
    expect(creations()).toHaveLength(0);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('discovers existing sessions without a notification and coalesces concurrent sync', async () => {
    const bridge = makeBridge();
    await bridge.reload();
    const first = bridge.syncSessions();
    expect(bridge.syncSessions()).toBe(first);
    expect(await first).toEqual({ state: 'complete', total: 2, ready: 2, failed: 0 });
    expect(creations()).toHaveLength(2);
    expect(Object.keys(await readFullMap(dir))).toEqual(['s1', 's2']);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('creates new session threads immediately even when legacy creation is lazy', async () => {
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    sessions.push({ id: 's3', name: 'new' });
    await Promise.all([bridge.sessionCreated('s3', 'new'), bridge.sessionCreated('s3', 'new')]);
    expect(creations()).toHaveLength(3);
  });

  it('does not discover or create restored sessions until boot hold is released', async () => {
    const bridge = makeBridge();
    bridge.hold();
    await bridge.reload();
    await bridge.sessionCreated('s1', 'w1-brain');
    await bridge.syncSessions();
    expect(creations()).toHaveLength(0);
    await bridge.release();
    await bridge.syncSessions();
    expect(creations()).toHaveLength(2);
  });

  it('preserves thread mappings across restart and switching back to notifications', async () => {
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    const before = await readFullMap(dir);
    bridge.stop();
    const restarted = makeBridge();
    await restarted.reload();
    await restarted.syncSessions();
    expect(creations()).toHaveLength(2);
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await restarted.reload();
    expect(await readFullMap(dir)).toEqual(before);
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
  });

  it('does nothing while disabled even when full mode is saved', async () => {
    await writeDiscordConfig(dir, { ...cfg, enabled: false });
    const bridge = makeBridge();
    await bridge.reload();
    await bridge.syncSessions();
    await bridge.sessionCreated('s3', 'new');
    expect(posts).toHaveLength(0);
  });

  it('reports failures and retries only missing destinations', async () => {
    let rejectSecond = true;
    const bridge = makeBridge(async (url, init) => {
      if (creations().length === 2 && rejectSecond) return Response.json({}, { status: 403 });
      return Response.json({ id: String(444444444444444440n + BigInt(sequence++)) });
    });
    await bridge.reload();
    expect(await bridge.syncSessions()).toMatchObject({ state: 'error', ready: 1, failed: 1 });
    rejectSecond = false;
    expect(await bridge.syncSessions()).toMatchObject({ state: 'complete', ready: 2, failed: 0 });
    expect(creations()).toHaveLength(3);
  });

  it('skips a tab deleted while the previous destination was being created', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (url, init) => {
      await pending;
      return Response.json({ id: '444444444444444444' });
    });
    await bridge.reload();
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    sessions = sessions.filter((s) => s.id !== 's2');
    await bridge.sessionDeleted('s2');
    release();
    await sync;
    expect(creations()).toHaveLength(1);
    expect(await readFullMap(dir)).not.toHaveProperty('s2');
  });

  it('does not recreate a tab deleted while its own destination is pending', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessions = sessions.slice(0, 1);
    const bridge = makeBridge(async (url, init) => {
      if (url.pathname.endsWith('/channels')) await pending;
      return Response.json({ id: '444444444444444444' });
    });
    await bridge.reload();
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    sessions = [];
    await bridge.sessionDeleted('s1');
    release();
    await sync;
    expect(await readFullMap(dir)).toEqual({});
    expect(posts.some((p) => p.method === 'DELETE')).toBe(true);
  });

  it('stops discovery after switching back to Notifications during a request', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (url, init) => {
      await pending;
      return Response.json({ id: '444444444444444444' });
    });
    await bridge.reload();
    const sync = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    await writeDiscordConfig(dir, { ...cfg, mode: 'notifications' });
    await bridge.reload();
    release();
    expect(await sync).toMatchObject({ state: 'idle' });
    expect(creations()).toHaveLength(1);
    expect(posts.some((p) => p.method === 'DELETE')).toBe(false);
  });

  it('queues a new discovery pass when the parent changes during creation', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = makeBridge(async (url, init) => {
      if (JSON.parse(String(init.body)).parent_id === cfg.categoryId) await pending;
      return Response.json({ id: String(444444444444444440n + BigInt(sequence++)) });
    });
    await bridge.reload();
    const first = bridge.syncSessions();
    await vi.waitFor(() => expect(creations()).toHaveLength(1));
    const newParent = '777777777777777777';
    await writeDiscordConfig(dir, { ...cfg, categoryId: newParent });
    await bridge.reload();
    release();
    await first;
    await vi.waitFor(() => expect(bridge.sessionSync).toMatchObject({ state: 'complete', ready: 2 }));
    expect(creations().filter((p) => p.body?.parent_id === newParent)).toHaveLength(2);
    expect(Object.keys(await readFullMap(dir))).toEqual(['s1', 's2']);
  });
});
