/** Fault injection for persistent deduplication and retry safety. No real Discord or terminal input. */
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordDeliveryJournal, DISCORD_DELIVERY_LIMIT } from '../src/discord-delivery.js';
import {
  DiscordApi,
  DiscordBridge,
  DEFAULT_DISCORD_CONFIG,
  writeDiscordConfig,
  type DiscordFetch,
  type GatewayMessage,
} from '../src/discord-bridge.js';

const GUILD = '111111111111111111';
const PARENT = '222222222222222222';
const USER = '333333333333333333';
const THREAD = '444444444444444444';
const MESSAGE = '555555555555555555';
const CFG = {
  ...DEFAULT_DISCORD_CONFIG,
  enabled: true,
  token: 'fake-secret-token',
  guildId: GUILD,
  parentChannelId: PARENT,
  allowedUserIds: [USER],
};
const MESSAGE_EVENT: GatewayMessage = {
  id: MESSAGE,
  guild_id: GUILD,
  channel_id: THREAD,
  author: { id: USER },
  content: 'perform this task once',
};
const meta = { id: 'in:one', direction: 'inbound' as const, channelId: THREAD, guildId: GUILD, sessionId: 's1' };
let dir: string;
let now: number;
let bridges: DiscordBridge[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-delivery-'));
  now = Date.now();
  bridges = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const b of bridges) b.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('delivery journal', () => {
  it('durably claims an ID once under concurrency, with private permissions', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    const claims = await Promise.all(Array.from({ length: 10 }, () => journal.claim(meta)));
    expect(claims.filter((c) => c.fresh)).toHaveLength(1);
    expect((await stat(join(dir, 'discord-delivery.json'))).mode & 0o777).toBe(0o600);
    expect((await new DiscordDeliveryJournal(dir, () => now).claim(meta)).fresh).toBe(false);
  });

  it.each(['received', 'files_transferred', 'submitting'] as const)(
    'reconciles interrupted %s without replaying input',
    async (state) => {
      const first = new DiscordDeliveryJournal(dir, () => now);
      await first.claim(meta);
      await first.update(meta.id, state);
      const restored = new DiscordDeliveryJournal(dir, () => now);
      const duplicate = await restored.claim(meta);
      expect(duplicate.fresh).toBe(false);
      expect(duplicate.record.state).toBe(state === 'submitting' ? 'uncertain' : 'failed');
      expect(duplicate.record.reason).toBe(state === 'submitting' ? 'restart_during_submit' : 'restart_before_submit');
    }
  );

  it('retains accepted input across restart and returns copies of bounded metadata', async () => {
    const first = new DiscordDeliveryJournal(dir, () => now);
    await first.claim(meta);
    await first.update(meta.id, 'input_accepted');
    const restored = new DiscordDeliveryJournal(dir, () => now);
    const records = await restored.recent();
    expect(records[0].state).toBe('input_accepted');
    records[0].state = 'failed';
    expect((await restored.recent())[0].state).toBe('input_accepted');
  });

  it('reconciles an accepted prompt only with exact native identity, prompt hash and a new user cursor', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    await journal.claim(meta);
    await journal.update(meta.id, 'input_accepted');
    const baseline = 'native:1:abc',
      user = 'native:2:def';
    await journal.annotate(meta.id, {
      native: { conversationId: 'native', promptHash: 'a'.repeat(64), afterCursor: baseline },
    });
    const history = {
      conversationId: 'native',
      partial: false,
      turns: [
        { cursor: baseline, role: 'assistant' as const, text: 'old', timestamp: '' },
        { cursor: user, role: 'user' as const, text: 'new', timestamp: '' },
      ],
      executions: [{ userCursor: user, promptHash: 'a'.repeat(64), state: 'completed' as const }],
    };
    await journal.reconcileNative('other', history);
    expect((await journal.recent())[0].state).toBe('input_accepted');
    await journal.reconcileNative(meta.sessionId!, { ...history, conversationId: 'other' });
    expect((await journal.recent())[0].state).toBe('input_accepted');
    await journal.reconcileNative(meta.sessionId!, history);
    expect((await journal.recent())[0].state).toBe('completed');
    const restored = new DiscordDeliveryJournal(dir, () => now);
    expect((await restored.recent())[0].native?.userCursor).toBe(user);
  });
  it.each(['input_accepted', 'submitting'] as const)(
    'recovers an unbound %s input from its verified boundary before a later page can echo it',
    async (state) => {
      const journal = new DiscordDeliveryJournal(dir, () => now);
      await journal.claim(meta);
      await journal.annotate(meta.id, {
        native: { conversationId: 'native', promptHash: 'a'.repeat(64), afterCursor: 'native:old' },
      });
      await journal.update(meta.id, state);
      const history = {
        conversationId: 'native',
        partial: true,
        verifiedAfter: 'native:later-tool',
        turns: [
          {
            cursor: 'native:user',
            role: 'user' as const,
            text: 'Prompt with [attached: /tmp/image.png]',
            timestamp: '',
          },
        ],
        executions: [{ userCursor: 'native:user', promptHash: 'a'.repeat(64), state: 'running' as const }],
      };
      const readAfter = vi.fn(async () => ({ ...history, verifiedAfter: 'native:old' }));
      await journal.reconcileNative('s1', history, readAfter);
      expect(readAfter).toHaveBeenCalledWith('native:old');
      expect(await journal.submittedUserCursors('s1', THREAD, 'native')).toEqual(new Set(['native:user']));
      const restored = new DiscordDeliveryJournal(dir, () => now);
      await restored.reconcileNative('s1', {
        ...history,
        executions: [{ ...history.executions[0], state: 'completed' }],
      });
      expect((await restored.recent())[0].state).toBe('completed');
    }
  );
  it('does not accept an unverified boundary or steal an identical externally typed prompt', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    await journal.claim(meta);
    await journal.annotate(meta.id, {
      native: { conversationId: 'native', promptHash: 'a'.repeat(64), afterCursor: 'native:old' },
    });
    await journal.update(meta.id, 'input_accepted');
    const external = {
      conversationId: 'native',
      partial: true,
      turns: [{ cursor: 'native:external', role: 'user' as const, text: 'same', timestamp: '' }],
      executions: [{ userCursor: 'native:external', promptHash: 'a'.repeat(64), state: 'running' as const }],
    };
    await expect(journal.reconcileNative('s1', external, async () => external)).rejects.toThrow('boundary');
    expect((await journal.submittedUserCursors('s1', THREAD, 'native')).size).toBe(0);
    await journal.reconcileNative('s1', external, async () => ({
      ...external,
      verifiedAfter: 'native:old',
      turns: [{ cursor: 'native:discord', role: 'user' as const, text: 'same', timestamp: '' }, ...external.turns],
      executions: [
        { userCursor: 'native:discord', promptHash: 'a'.repeat(64), state: 'completed' },
        ...external.executions,
      ],
    }));
    expect(await journal.submittedUserCursors('s1', THREAD, 'native')).toEqual(new Set(['native:discord']));
  });
  it('serializes concurrent native reads so identical pending inputs cannot claim one execution twice', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    for (const id of ['first', 'second']) {
      await journal.claim({ ...meta, id });
      await journal.annotate(id, {
        native: { conversationId: 'native', promptHash: 'a'.repeat(64), afterCursor: 'native:old' },
      });
      await journal.update(id, 'input_accepted');
    }
    const h = {
      conversationId: 'native',
      partial: true,
      verifiedAfter: 'native:old',
      turns: [{ cursor: 'native:user', role: 'user' as const, text: 'same', timestamp: '' }],
      executions: [{ userCursor: 'native:user', promptHash: 'a'.repeat(64), state: 'running' as const }],
    };
    await Promise.all([journal.reconcileNative('s1', h), journal.reconcileNative('s1', h)]);
    expect((await journal.recent()).filter((r) => r.native?.userCursor === 'native:user')).toHaveLength(1);
  });
  it('finds exact Discord-origin native cursors across the full durable ledger and scoped destination', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    for (let i = 0; i < 15; i++) {
      await journal.claim({ ...meta, id: 'input:' + i });
      await journal.annotate('input:' + i, {
        native: { conversationId: 'native', promptHash: 'a'.repeat(64), userCursor: 'user:' + i },
      });
    }
    await journal.claim({ ...meta, id: 'hash-only' });
    await journal.annotate('hash-only', { native: { conversationId: 'native', promptHash: 'a'.repeat(64) } });
    await journal.claim({ ...meta, id: 'out', direction: 'outbound' });
    await journal.annotate('out', {
      native: { conversationId: 'native', promptHash: 'a'.repeat(64), userCursor: 'foreign' },
    });
    expect((await journal.submittedUserCursors('s1', THREAD, 'native')).size).toBe(15);
    expect(await journal.submittedUserCursors('other', THREAD, 'native')).toEqual(new Set());
    expect(await journal.submittedUserCursors('s1', PARENT, 'native')).toEqual(new Set());
    expect(await journal.submittedUserCursors('s1', THREAD, 'other-conversation')).toEqual(new Set());
    const restored = new DiscordDeliveryJournal(dir, () => now);
    expect(await restored.submittedUserCursors('s1', THREAD, 'native')).toContain('user:0');
  });
  it('fails closed on corruption, oversized metadata and symlinks', async () => {
    const path = join(dir, 'discord-delivery.json');
    for (const contents of ['not JSON', '{}', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
      await writeFile(path, contents);
      await expect(new DiscordDeliveryJournal(dir).claim(meta)).rejects.toThrow(/journal/i);
    }
    await rm(path);
    const outside = join(dir, 'outside');
    await writeFile(outside, '[]');
    await symlink(outside, path);
    await expect(new DiscordDeliveryJournal(dir).claim(meta)).rejects.toThrow(/journal/i);
  });

  it('never evicts recent inbound IDs when saturated, but expires records after seven days', async () => {
    const records = Array.from({ length: DISCORD_DELIVERY_LIMIT }, (_, i) => ({
      ...meta,
      id: String(i),
      state: 'input_accepted',
      createdAt: now,
      updatedAt: now,
    }));
    await writeFile(join(dir, 'discord-delivery.json'), JSON.stringify(records));
    const journal = new DiscordDeliveryJournal(dir, () => now);
    await expect(journal.claim(meta)).rejects.toThrow(/full/);
    now += 8 * 24 * 60 * 60 * 1000;
    expect((await journal.claim(meta)).fresh).toBe(true);
  });
});

describe('Discord retry rules', () => {
  it('uses one nonce after an accepted request loses its response', async () => {
    const seen = new Set<string>();
    const bodies: any[] = [];
    const api = new DiscordApi(
      () => CFG.token,
      async (_url, init) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (!seen.has(body.nonce)) {
          seen.add(body.nonce);
          throw new TypeError('lost response');
        }
        return Response.json({ id: MESSAGE });
      },
      async () => undefined
    );
    expect(await api.post(THREAD, { content: 'hello', allowed_mentions: { parse: [], users: [] } })).toEqual({
      id: MESSAGE,
    });
    expect(bodies).toHaveLength(2);
    expect(seen.size).toBe(1);
    expect(bodies[0]).toMatchObject({ enforce_nonce: true });
    expect(bodies[0].nonce.length).toBeLessThanOrEqual(25);
  });

  it('retries server errors a bounded number of times, but not permission failures', async () => {
    const fetch = vi.fn<DiscordFetch>(async () => Response.json({}, { status: 503 }));
    const api = new DiscordApi(
      () => CFG.token,
      fetch,
      async () => undefined
    );
    await expect(api.post(THREAD, { content: 'hello', allowed_mentions: { parse: [], users: [] } })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockClear().mockImplementation(async () => Response.json({}, { status: 403 }));
    await expect(api.post(THREAD, { content: 'hello', allowed_mentions: { parse: [], users: [] } })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry ambiguous non-idempotent thread creation', async () => {
    const fetch = vi.fn<DiscordFetch>(async () => {
      throw new TypeError('lost response');
    });
    const api = new DiscordApi(
      () => CFG.token,
      fetch,
      async () => undefined
    );
    await expect(api.createThread(PARENT, 'test')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('honors retry_after and refuses to retry early when the wait exceeds its bound', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn<DiscordFetch>(async () => Response.json({ retry_after: 45 }, { status: 429 }));
    const api = new DiscordApi(() => CFG.token, fetch, sleep);
    await expect(api.post(THREAD, { content: 'hello', allowed_mentions: { parse: [], users: [] } })).rejects.toThrow(
      /429/
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps multipart file nonce stable through retries', async () => {
    const nonces: string[] = [];
    const api = new DiscordApi(
      () => CFG.token,
      async (_url, init) => {
        nonces.push(JSON.parse(String((init.body as FormData).get('payload_json'))).nonce);
        return nonces.length === 1 ? Response.json({}, { status: 502 }) : Response.json({ id: MESSAGE });
      },
      async () => undefined
    );
    await api.postWithFile(
      THREAD,
      { content: 'file', allowed_mentions: { parse: [], users: [] } },
      { name: 'a.txt', data: new Uint8Array([1]) }
    );
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
  });
});

async function ready(sendInput = vi.fn(async () => true), fetchOverride?: DiscordFetch) {
  await writeDiscordConfig(dir, CFG);
  const b = new DiscordBridge({
    configDir: dir,
    now: () => now,
    sendInput,
    sleep: async () => undefined,
    fetchImpl:
      fetchOverride ?? (async (url) => Response.json({ id: url.pathname.endsWith('/threads') ? THREAD : MESSAGE })),
    socketFactory: () => ({ send() {}, close() {}, on() {} }),
  });
  bridges.push(b);
  await b.notify({ event: 'test', title: 'test', body: 'test', urgency: 'critical', sessionId: 's1' });
  return { b, sendInput };
}

describe('inbound submission safety', () => {
  it('retries saving a known thread mapping without creating another thread', async () => {
    let refuseMapping = true;
    let creations = 0;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === join(dir, 'discord-bridge.json') && refuseMapping && creations > 0)
        throw new Error('storage unavailable');
      return rename(from, to);
    });
    const { b } = await ready(undefined, async (url) => {
      if (url.pathname.endsWith('/threads')) creations++;
      return Response.json({ id: url.pathname.endsWith('/threads') ? THREAD : MESSAGE });
    });
    refuseMapping = false;
    const result = await b.notify({
      event: 'retry',
      title: 'retry',
      body: 'retry',
      urgency: 'critical',
      sessionId: 's1',
    });
    expect(result?.ok).toBe(true);
    expect(creations).toBe(1);
    expect(JSON.parse(await readFile(join(dir, 'discord-bridge.json'), 'utf8')).threads.s1).toBe(THREAD);
  });

  it('submits once for concurrent duplicate events and once across a restart', async () => {
    const { b, sendInput } = await ready();
    await Promise.all([b.onGatewayMessage(MESSAGE_EVENT), b.onGatewayMessage(MESSAGE_EVENT)]);
    b.stop();
    now += 10_000;
    const restored = await ready(sendInput);
    await restored.b.onGatewayMessage(MESSAGE_EVENT);
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('persists the submitting boundary before calling input and never stores prompt/token contents', async () => {
    const input = vi.fn(async () => {
      const raw = await readFile(join(dir, 'discord-delivery.json'), 'utf8');
      expect(JSON.parse(raw).find((r: any) => r.direction === 'inbound').state).toBe('submitting');
      expect(raw).not.toContain(MESSAGE_EVENT.content);
      expect(raw).not.toContain(CFG.token);
      return true;
    });
    const { b } = await ready(input);
    await b.onGatewayMessage(MESSAGE_EVENT);
    expect(input).toHaveBeenCalledTimes(1);
    expect((await b.recentDeliveries()).find((r) => r.direction === 'inbound')?.state).toBe('input_accepted');
  });

  it('does not replay a partial/throwing input or confuse it with verified execution', async () => {
    const input = vi.fn(async () => {
      throw new Error('partial write');
    });
    const { b } = await ready(input);
    await b.onGatewayMessage(MESSAGE_EVENT);
    now += 10_000;
    await b.onGatewayMessage(MESSAGE_EVENT);
    expect(input).toHaveBeenCalledTimes(1);
    expect((await b.recentDeliveries()).find((r) => r.direction === 'inbound')?.state).toBe('uncertain');
  });

  it('does not submit text when any attachment transfer fails', async () => {
    const { b, sendInput } = await ready();
    await b.onGatewayMessage({
      ...MESSAGE_EVENT,
      attachments: [{ id: 'a', filename: 'image.png', size: 2, url: 'https://cdn.discordapp.com/x' }],
    });
    expect(sendInput).not.toHaveBeenCalled();
    expect((await b.recentDeliveries()).find((r) => r.direction === 'inbound')?.state).toBe('failed');
  });

  it('does not claim successful multi-part output when a trailing part is refused', async () => {
    let parts = 0;
    const { b } = await ready(undefined, async (url) => {
      if (url.pathname.endsWith('/threads')) return Response.json({ id: THREAD });
      return ++parts >= 3 ? Response.json({}, { status: 403 }) : Response.json({ id: MESSAGE });
    });
    now += 10_000;
    const result = await b.notify({
      event: 'done',
      title: 'done',
      body: 'done',
      sessionId: 's1',
      urgency: 'critical',
      fullText: async () => ({ text: 'a long output paragraph\n\n'.repeat(300), version: 'turn1' }),
    });
    expect(result?.ok).toBe(false);
    expect((await b.recentDeliveries()).some((r) => r.direction === 'outbound' && r.state === 'failed')).toBe(true);
  });

  it('retries a refused trailing part without repeating the already delivered start', async () => {
    let refuse = false;
    let index = 0;
    const contents: string[] = [];
    const { b } = await ready(undefined, async (url, init) => {
      if (url.pathname.endsWith('/threads')) return Response.json({ id: THREAD });
      const body = JSON.parse(String(init.body));
      if (refuse && ++index === 2) return Response.json({}, { status: 403 });
      contents.push(body.content);
      return Response.json({ id: MESSAGE });
    });
    const msg = {
      event: 'done',
      title: 'done',
      body: 'done',
      sessionId: 's1',
      urgency: 'critical' as const,
      fullText: async () => ({
        text: Array.from({ length: 150 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(50)}`).join('\n\n'),
        version: 'turn1',
      }),
    };
    now += 10_000;
    refuse = true;
    expect((await b.notify(msg))?.ok).toBe(false);
    refuse = false;
    expect((await b.notify(msg))?.ok).toBe(true);
    expect(contents.filter((c) => c.includes('Paragraph 0:'))).toHaveLength(1);
  });

  it('does not blindly replay output after retry exhaustion leaves delivery uncertain', async () => {
    let fail = false;
    let requests = 0;
    const { b } = await ready(undefined, async (url) => {
      if (url.pathname.endsWith('/threads')) return Response.json({ id: THREAD });
      requests++;
      if (fail) throw new TypeError('lost response');
      return Response.json({ id: MESSAGE });
    });
    const msg = {
      event: 'done',
      title: 'done',
      body: 'done',
      sessionId: 's1',
      urgency: 'critical' as const,
      fullText: async () => ({ text: 'one exact native response', version: 'turn1' }),
    };
    now += 10_000;
    fail = true;
    expect((await b.notify(msg))?.ok).toBe(false);
    const before = requests;
    fail = false;
    expect((await b.notify(msg))?.ok).toBe(false);
    expect(requests).toBe(before);
  });

  it('refuses a changed rendering plan after part of a response has been delivered', async () => {
    let count = 0;
    let refuse = false;
    const { b } = await ready(undefined, async (url) => {
      if (url.pathname.endsWith('/threads')) return Response.json({ id: THREAD });
      count++;
      return refuse && count === 3 ? Response.json({}, { status: 403 }) : Response.json({ id: MESSAGE });
    });
    const msg = {
      event: 'done',
      title: 'original title',
      body: 'done',
      sessionId: 's1',
      urgency: 'critical' as const,
      fullText: async () => ({ text: 'a long native response paragraph\n\n'.repeat(150), version: 'turn1' }),
    };
    now += 10_000;
    refuse = true;
    expect((await b.notify(msg))?.ok).toBe(false);
    const before = count;
    refuse = false;
    const changed = await b.notify({ ...msg, title: 'different rendering header' });
    expect(changed?.ok).toBe(false);
    expect(changed?.error).toMatch(/formatting changed/);
    expect(count).toBe(before);
  });
});
it('fingerprints embed text and color so a changed card cannot replay an existing delivery plan', async () => {
  const { b } = await ready();
  const post = {
    content: '',
    embeds: [{ description: 'first rendering', color: 0x58a6ff }],
    allowed_mentions: { parse: [], users: [] },
  };
  type ResponsePost = typeof post;
  const send = (
    b as unknown as {
      deliverPost: (
        channel: string,
        post: ResponsePost,
        file: undefined,
        session: string,
        key: string
      ) => Promise<unknown>;
    }
  ).deliverPost.bind(b);
  await send(THREAD, post, undefined, 's1', 'response-card');
  await expect(
    send(
      THREAD,
      { ...post, embeds: [{ description: 'different rendering', color: 0xed6b6b }] },
      undefined,
      's1',
      'response-card'
    )
  ).rejects.toThrow('formatting changed');
});
