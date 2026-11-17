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
        native: {
          conversationId: '12345678-1234-1234-1234-123456789abc',
          promptHash: 'a'.repeat(64),
          afterCursor: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
        },
      });
      await journal.update(meta.id, state);
      const history = {
        conversationId: '12345678-1234-1234-1234-123456789abc',
        partial: true,
        verifiedAfter: '12345678-1234-1234-1234-123456789abc:20:aaaaaaaaaaaaaaaa',
        turns: [
          {
            cursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
            role: 'user' as const,
            text: 'Prompt with [attached: /tmp/image.png]',
            timestamp: '',
          },
        ],
        executions: [
          {
            userCursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
            promptHash: 'a'.repeat(64),
            state: 'running' as const,
          },
        ],
      };
      const readAfter = vi.fn(async () => ({
        ...history,
        verifiedAfter: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
      }));
      if (state === 'submitting') {
        expect(await journal.reconcileNative('s1', history, readAfter)).toBe(false);
        expect((await journal.submittedUserCursors('s1', THREAD, '12345678-1234-1234-1234-123456789abc')).size).toBe(0);
        await journal.update(meta.id, 'input_accepted');
      }
      expect(await journal.reconcileNative('s1', history, readAfter)).toBe(true);
      expect(readAfter).toHaveBeenCalledWith('12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa');
      expect(await journal.submittedUserCursors('s1', THREAD, '12345678-1234-1234-1234-123456789abc')).toEqual(
        new Set(['12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa'])
      );
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
      native: {
        conversationId: '12345678-1234-1234-1234-123456789abc',
        promptHash: 'a'.repeat(64),
        afterCursor: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
      },
    });
    await journal.update(meta.id, 'input_accepted');
    const external = {
      conversationId: '12345678-1234-1234-1234-123456789abc',
      partial: true,
      verifiedAfter: '12345678-1234-1234-1234-123456789abc:20:aaaaaaaaaaaaaaaa',
      turns: [
        {
          cursor: '12345678-1234-1234-1234-123456789abc:40:aaaaaaaaaaaaaaaa',
          role: 'user' as const,
          text: 'same',
          timestamp: '',
        },
      ],
      executions: [
        {
          userCursor: '12345678-1234-1234-1234-123456789abc:40:aaaaaaaaaaaaaaaa',
          promptHash: 'a'.repeat(64),
          state: 'running' as const,
        },
      ],
    };
    await journal.reconcileNative('s1', external, async () => external);
    expect((await journal.submittedUserCursors('s1', THREAD, '12345678-1234-1234-1234-123456789abc')).size).toBe(0);
    await journal.reconcileNative('s1', external, async () => ({
      ...external,
      verifiedAfter: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
      turns: [
        {
          cursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
          role: 'user' as const,
          text: 'same',
          timestamp: '',
        },
        ...external.turns,
      ],
      executions: [
        {
          userCursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
          promptHash: 'a'.repeat(64),
          state: 'completed',
        },
        ...external.executions,
      ],
    }));
    expect(await journal.submittedUserCursors('s1', THREAD, '12345678-1234-1234-1234-123456789abc')).toEqual(
      new Set(['12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa'])
    );
  });
  it('serializes concurrent native reads so identical pending inputs cannot claim one execution twice', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    for (const id of ['first', 'second']) {
      await journal.claim({ ...meta, id });
      await journal.annotate(id, {
        native: {
          conversationId: '12345678-1234-1234-1234-123456789abc',
          promptHash: 'a'.repeat(64),
          afterCursor: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
        },
      });
      await journal.update(id, 'input_accepted');
    }
    const h = {
      conversationId: '12345678-1234-1234-1234-123456789abc',
      partial: true,
      verifiedAfter: '12345678-1234-1234-1234-123456789abc:10:aaaaaaaaaaaaaaaa',
      turns: [
        {
          cursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
          role: 'user' as const,
          text: 'same',
          timestamp: '',
        },
      ],
      executions: [
        {
          userCursor: '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa',
          promptHash: 'a'.repeat(64),
          state: 'running' as const,
        },
      ],
    };
    await Promise.all([journal.reconcileNative('s1', h), journal.reconcileNative('s1', h)]);
    expect(
      (await journal.recent()).filter(
        (r) => r.native?.userCursor === '12345678-1234-1234-1234-123456789abc:30:aaaaaaaaaaaaaaaa'
      )
    ).toHaveLength(1);
  });
  it.each(['anchor', 'metadata'] as const)(
    'binds Discord provenance when a verified page omits its %s boundary',
    async (kind) => {
      const journal = new DiscordDeliveryJournal(dir, () => now);
      const conv = '12345678-1234-1234-1234-123456789abc';
      const baseline = conv + ':100:aaaaaaaaaaaaaaaa',
        verified = kind === 'anchor' ? baseline : conv + ':150:bbbbbbbbbbbbbbbb',
        user = conv + ':200:cccccccccccccccc';
      await journal.claim(meta);
      await journal.update(meta.id, 'input_accepted');
      await journal.annotate(meta.id, {
        native: { conversationId: conv, promptHash: 'a'.repeat(64), afterCursor: baseline },
      });
      const h = {
        conversationId: conv,
        partial: true,
        verifiedAfter: verified,
        turns: [{ role: 'user' as const, cursor: user, text: 'Same prompt', timestamp: '' }],
        executions: [{ userCursor: user, promptHash: 'a'.repeat(64), state: 'running' as const }],
      };
      await journal.reconcileNative('s1', h, async (after) => ({ ...h, verifiedAfter: after }));
      expect(await journal.submittedUserCursors('s1', THREAD, conv)).toEqual(new Set([user]));
      const restored = new DiscordDeliveryJournal(dir, () => now);
      expect((await restored.recent())[0].native?.userCursor).toBe(user);
    }
  );

  it.each([
    'unverified',
    'changed anchor',
    'foreign anchor',
    'older page',
    'unsafe offset',
    'foreign user',
    'old user',
    'wrong hash',
  ])('does not guess Discord provenance from a paged prompt with %s', async (kind) => {
    const journal = new DiscordDeliveryJournal(dir, () => now),
      conv = '12345678-1234-1234-1234-123456789abc';
    const baseline = conv + ':100:aaaaaaaaaaaaaaaa';
    let verified: string | undefined = conv + ':150:bbbbbbbbbbbbbbbb',
      user = conv + ':200:cccccccccccccccc';
    if (kind === 'unverified') verified = undefined;
    if (kind === 'changed anchor') verified = conv + ':100:dddddddddddddddd';
    if (kind === 'foreign anchor') verified = 'abcdef12-1234-1234-1234-123456789abc:150:bbbbbbbbbbbbbbbb';
    if (kind === 'older page') verified = conv + ':50:bbbbbbbbbbbbbbbb';
    if (kind === 'unsafe offset') verified = conv + ':9007199254740992:bbbbbbbbbbbbbbbb';
    if (kind === 'foreign user') user = 'abcdef12-1234-1234-1234-123456789abc:200:cccccccccccccccc';
    if (kind === 'old user') user = conv + ':120:cccccccccccccccc';
    await journal.claim(meta);
    await journal.update(meta.id, 'input_accepted');
    await journal.annotate(meta.id, {
      native: { conversationId: conv, promptHash: 'a'.repeat(64), afterCursor: baseline },
    });
    await journal.reconcileNative('s1', {
      conversationId: conv,
      partial: true,
      verifiedAfter: verified,
      turns: [{ role: 'user', cursor: user, text: 'Prompt', timestamp: '' }],
      executions: [{ userCursor: user, promptHash: (kind === 'wrong hash' ? 'b' : 'a').repeat(64), state: 'running' }],
    });
    expect(await journal.submittedUserCursors('s1', THREAD, conv)).toEqual(new Set());
  });

  it('verifies the original submission page instead of attributing later identical external text to an old record', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now),
      conv = '12345678-1234-1234-1234-123456789abc';
    const baseline = conv + ':100:aaaaaaaaaaaaaaaa',
      original = conv + ':200:cccccccccccccccc',
      boundary = conv + ':500:bbbbbbbbbbbbbbbb',
      external = conv + ':600:dddddddddddddddd';
    await journal.claim(meta);
    await journal.update(meta.id, 'input_accepted');
    await journal.annotate(meta.id, {
      native: { conversationId: conv, promptHash: 'a'.repeat(64), afterCursor: baseline },
    });
    const read = vi.fn(async (after: string) => ({
      conversationId: conv,
      partial: true,
      verifiedAfter: after,
      turns: [{ cursor: original, role: 'user' as const, text: 'Same text', timestamp: '' }],
      executions: [{ userCursor: original, promptHash: 'a'.repeat(64), state: 'completed' as const }],
    }));
    await journal.reconcileNative(
      's1',
      {
        conversationId: conv,
        partial: true,
        verifiedAfter: boundary,
        turns: [{ cursor: external, role: 'user', text: 'Same text', timestamp: '' }],
        executions: [{ userCursor: external, promptHash: 'a'.repeat(64), state: 'running' }],
      },
      read
    );
    expect(read).toHaveBeenCalledWith(baseline);
    expect(await journal.submittedUserCursors('s1', THREAD, conv)).toEqual(new Set([original]));
  });

  it.each(['wrong anchor', 'wrong conversation', 'read failure'])(
    'refuses an unverified fallback page: %s',
    async (kind) => {
      const journal = new DiscordDeliveryJournal(dir, () => now),
        conv = '12345678-1234-1234-1234-123456789abc';
      const baseline = conv + ':100:aaaaaaaaaaaaaaaa',
        boundary = conv + ':150:bbbbbbbbbbbbbbbb',
        user = conv + ':200:cccccccccccccccc';
      await journal.claim(meta);
      await journal.update(meta.id, 'input_accepted');
      await journal.annotate(meta.id, {
        native: { conversationId: conv, promptHash: 'a'.repeat(64), afterCursor: baseline },
      });
      const h = {
        conversationId: conv,
        partial: true,
        verifiedAfter: boundary,
        turns: [{ cursor: user, role: 'user' as const, text: 'Prompt', timestamp: '' }],
        executions: [{ userCursor: user, promptHash: 'a'.repeat(64), state: 'running' as const }],
      };
      await journal.reconcileNative('s1', h, async () => {
        if (kind === 'read failure') throw Error('unavailable');
        return {
          ...h,
          verifiedAfter: kind === 'wrong anchor' ? boundary : baseline,
          conversationId: kind === 'wrong conversation' ? 'foreign' : conv,
        };
      });
      expect(await journal.submittedUserCursors('s1', THREAD, conv)).toEqual(new Set());
    }
  );

  it('continues an already bound native execution even when its original baseline is outside the page', async () => {
    const journal = new DiscordDeliveryJournal(dir, () => now);
    await journal.claim(meta);
    await journal.update(meta.id, 'running');
    await journal.annotate(meta.id, {
      native: { conversationId: 'native', promptHash: 'a'.repeat(64), afterCursor: 'older', userCursor: 'exact-user' },
    });
    await journal.reconcileNative('s1', {
      conversationId: 'native',
      partial: true,
      turns: [],
      executions: [{ userCursor: 'exact-user', promptHash: 'a'.repeat(64), state: 'completed' }],
    });
    expect((await journal.recent())[0].state).toBe('completed');
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
