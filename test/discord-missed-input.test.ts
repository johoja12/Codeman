import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eligibleMissedInput, missedInputTime } from '../src/discord-missed-input.js';
import { DEFAULT_DISCORD_CONFIG, DiscordBridge, type GatewayMessage } from '../src/discord-bridge.js';
import { DiscordDeliveryJournal } from '../src/discord-delivery.js';
import type { DiscordHistory } from '../src/discord-history.js';
const now = Date.now(),
  guild = '111111111111111111',
  channel = '222222222222222222',
  actor = '333333333333333333';
const snow = (age: number) => String(BigInt(now - age - 1420070400000) << 22n);
const source: GatewayMessage = {
  id: snow(120000),
  guild_id: guild,
  channel_id: channel,
  author: { id: actor },
  content: 'Continue current work',
};
const scope = { now, guild, channel, allowed: [actor] };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it('only discovers settled recent, allowlisted human text in the exact thread', () => {
  expect(missedInputTime(source.id)).toBe(now - 120000);
  expect(eligibleMissedInput(source, scope)).toBe(true);
  for (const patch of [
    { id: snow(1000) },
    { id: snow(25 * 3600000) },
    { id: 'bad' },
    { id: String(1n << 64n) },
    { channel_id: 'other' },
    { guild_id: 'other' },
    { author: { id: 'other' } },
    { author: { id: actor, bot: true } },
    { webhook_id: 'webhook' },
    { content: '  !codeman stop' },
    { content: '' },
    { content: '\u001b[31mcommand' },
    { content: 'x'.repeat(4001) },
    { type: 6 },
    { attachments: [{ id: 'file' }] },
  ])
    expect(eligibleMissedInput({ ...source, ...patch } as GatewayMessage, scope), JSON.stringify(patch)).toBe(false);
});
type Harness = {
  scanMissedInput(): Promise<void>;
  resendMissedInput(
    id: string,
    channel: string,
    source: GatewayMessage,
    conversation: string,
    scope: string
  ): Promise<{ handled: boolean; text: string }>;
  channels: { channelForSession: () => string; activityOwned: ReturnType<typeof vi.fn> };
  nativeUi: { missedInputCard: ReturnType<typeof vi.fn> };
  api: { channelMessages: ReturnType<typeof vi.fn>; getMessage: ReturnType<typeof vi.fn> };
  inbound: Map<string, Promise<void>>;
  submitUiPrompt: ReturnType<typeof vi.fn>;
};
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'discord-missed-'));
  dirs.push(dir);
  const config = {
    ...DEFAULT_DISCORD_CONFIG,
    enabled: true,
    mode: 'full' as const,
    token: 'fake-only',
    guildId: guild,
    parentChannelId: channel,
    allowedUserIds: [actor],
  };
  const history: DiscordHistory = { conversationId: 'exact-conversation', turns: [], partial: false };
  const views = [{ id: 's1', conversation: history.conversationId, exited: false }];
  const sendInput = vi.fn(async () => true);
  const bridge = new DiscordBridge({
    configDir: dir,
    fetchImpl: vi.fn(),
    now: () => now,
    sendInput,
    sessions: () => [{ id: 's1', name: 'w1-test', working: false, mode: 'codex' }],
    history: async () => history,
  });
  Object.assign(bridge, { cfg: config });
  const h = bridge as unknown as Harness;
  // Inject transport/ownership boundaries; exercise the real scanner and durable journal.
  Object.assign(h, {
    channels: { channelForSession: () => channel, activityOwned: vi.fn(async () => true) },
    nativeUi: { missedInputCard: vi.fn(async () => {}) },
    api: { channelMessages: vi.fn(async () => [source]), getMessage: vi.fn(async () => source) },
  });
  Object.assign((bridge as unknown as { deps: object }).deps, {
    nativeUi: { enabled: () => true, sessions: async () => views },
  });
  // Scanner's destination gate is tested against changed mappings separately.
  Object.assign(bridge, { destinationMatches: () => true });
  h.submitUiPrompt = vi.fn(async () => 'accepted');
  const journal = new DiscordDeliveryJournal(dir, () => now);
  return { bridge, h, journal, history, views, sendInput, dir };
}
describe('missed inbound reconciliation', () => {
  it('offers review without input, then durably permits only one explicit submission', async () => {
    const f = await fixture();
    await f.h.scanMissedInput();
    expect(f.h.nativeUi.missedInputCard).toHaveBeenCalledWith(
      's1',
      channel,
      source,
      'exact-conversation',
      false,
      expect.any(Function)
    );
    expect(f.sendInput).not.toHaveBeenCalled();
    expect(f.h.submitUiPrompt).not.toHaveBeenCalled();
    const confirm = f.h.nativeUi.missedInputCard.mock.calls[0][5] as () => Promise<unknown>;
    await Promise.all([confirm(), confirm()]);
    expect(f.h.submitUiPrompt).toHaveBeenCalledTimes(1);
    expect(f.h.submitUiPrompt).toHaveBeenCalledWith(
      's1',
      channel,
      actor,
      'missed:' + source.id,
      source.content + '\r',
      'exact-conversation',
      false,
      undefined,
      expect.any(Function)
    );
    expect(await f.journal.get('in:' + guild + ':' + source.id)).toMatchObject({
      state: 'delivered',
      reason: 'missed_gateway',
    });
  });
  it('rechecks the recovery guard after waiting behind another inbound operation', async () => {
    const f = await fixture();
    let release!: () => void;
    f.h.inbound.set(
      channel,
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const submit = Object.getPrototypeOf(f.bridge).submitUiPrompt.bind(f.bridge);
    let valid = true;
    const result = submit(
      's1',
      channel,
      actor,
      'missed:' + source.id,
      source.content,
      'exact-conversation',
      false,
      undefined,
      () => valid
    );
    valid = false;
    release();
    expect(await result).toBe('blocked');
    expect(f.sendInput).not.toHaveBeenCalled();
  });
  it('continues discovery past earlier pending reviews on subsequent scans', async () => {
    const f = await fixture();
    const messages = Array.from({ length: 5 }, (_, i) => ({ ...source, id: snow(120000 + i) }));
    f.h.api.channelMessages.mockResolvedValue(messages);
    await f.h.scanMissedInput();
    expect(f.h.nativeUi.missedInputCard).toHaveBeenCalledTimes(3);
    f.h.nativeUi.missedInputCard.mockClear();
    await f.h.scanMissedInput();
    expect(f.h.nativeUi.missedInputCard).toHaveBeenCalledTimes(5);
    expect(f.h.submitUiPrompt).not.toHaveBeenCalled();
  });
  it('keeps uncertain confirmation closed after restart', async () => {
    const f = await fixture();
    await f.h.scanMissedInput();
    f.h.submitUiPrompt.mockRejectedValue(new Error('uncertain transport'));
    const confirm = f.h.nativeUi.missedInputCard.mock.calls[0][5] as () => Promise<unknown>;
    await confirm();
    Object.assign(f.bridge, { deliveries: new DiscordDeliveryJournal(f.dir, () => now) });
    f.h.nativeUi.missedInputCard.mockClear();
    await f.h.scanMissedInput();
    expect(f.h.nativeUi.missedInputCard.mock.calls[0][4]).toBe(true);
    await confirm();
    expect(f.h.submitUiPrompt).toHaveBeenCalledTimes(1);
  });
  it('suppresses a native user match without offering historical input', async () => {
    const f = await fixture();
    f.history.turns = [{ role: 'user', text: source.content, cursor: 'u1', timestamp: '' }];
    await f.h.scanMissedInput();
    expect(f.h.nativeUi.missedInputCard.mock.calls[0][4]).toBe(true);
    expect(f.h.submitUiPrompt).not.toHaveBeenCalled();
    expect(await f.journal.get('in:' + guild + ':' + source.id)).toMatchObject({ state: 'cancelled' });
  });
  it.each([
    'receipt',
    'inbound busy',
    'unowned',
    'exited',
    'unknown conversation',
    'wrong author',
    'suppressed',
    'controls disabled',
  ])('skips discovery for %s', async (kind) => {
    const f = await fixture();
    if (kind === 'receipt')
      await f.journal.claim({
        id: 'in:' + guild + ':' + source.id,
        direction: 'inbound',
        sessionId: 's1',
        channelId: channel,
        guildId: guild,
      });
    // Recreate so the bridge loads the durable receipt written by the independent journal.
    if (kind === 'receipt') Object.assign(f.bridge, { deliveries: new DiscordDeliveryJournal(f.dir, () => now) });
    if (kind === 'inbound busy') f.h.inbound.set(channel, Promise.resolve());
    if (kind === 'unowned') f.h.channels.activityOwned.mockResolvedValue(false);
    if (kind === 'exited') f.views[0].exited = true;
    if (kind === 'unknown conversation') f.views[0].conversation = '';
    if (kind === 'suppressed') Object.assign((f.bridge as unknown as { deps: object }).deps, { sessions: () => [] });
    if (kind === 'controls disabled')
      Object.assign((f.bridge as unknown as { deps: { nativeUi: object } }).deps.nativeUi, { enabled: () => false });
    if (kind === 'wrong author') f.h.api.channelMessages.mockResolvedValue([{ ...source, author: { id: 'other' } }]);
    await f.h.scanMissedInput();
    expect(f.h.nativeUi.missedInputCard).not.toHaveBeenCalled();
    expect(f.sendInput).not.toHaveBeenCalled();
  });
  it.each(['conversation', 'edited', 'already in native', 'destination', 'disabled'])(
    'revalidates %s at confirmation',
    async (kind) => {
      const f = await fixture();
      await f.h.scanMissedInput();
      const confirm = f.h.nativeUi.missedInputCard.mock.calls[0][5] as () => Promise<unknown>;
      if (kind === 'conversation') f.views[0].conversation = 'changed';
      if (kind === 'edited') f.h.api.getMessage.mockResolvedValue({ ...source, content: 'changed' });
      if (kind === 'already in native')
        f.history.turns = [{ role: 'user', text: source.content, cursor: 'u1', timestamp: '' }];
      if (kind === 'destination') Object.assign(f.bridge, { destinationMatches: () => false });
      if (kind === 'disabled') Object.assign(f.bridge, { stopped: true });
      await confirm();
      expect(f.h.submitUiPrompt).not.toHaveBeenCalled();
    }
  );
});
