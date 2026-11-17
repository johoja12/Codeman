/** Recovery guards invoke only fake Session ports; no SSH, native CLI or model call. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import * as remoteIdentity from '../src/discord-remote-conversation.js';
import type { Session } from '../src/session.js';
const conversation = '11111111-1111-4111-8111-111111111111';
afterEach(() => vi.restoreAllMocks());
function fixture(initial: { state: string; canResume?: boolean }, mode = 'claude') {
  const session = {
    id: 's1',
    name: 'test',
    mode,
    muxName: 'codeman-test',
    nativeResumeId: conversation,
    remote: { host: 'worker' },
    isAdopted: false,
    suppressNotifications: false,
    resumeExitedRemote: vi.fn(async () => true),
    reattachRemote: vi.fn(async () => true),
  } as unknown as Session;
  const host = {
    discordRecovering: new Set(),
    discordHealth: {
      check: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue({ state: 'available' }),
      invalidate: vi.fn(),
    },
    mux: { isPaneDead: vi.fn(async () => true) },
    noteRemoteReconnect: vi.fn(),
    persistSessionState: vi.fn(),
    broadcastSessionStateDebounced: vi.fn(),
  };
  const method = (
    WebServer.prototype as unknown as {
      recoverDiscordSession: (s: Session, current: () => boolean) => Promise<boolean>;
    }
  ).recoverDiscordSession;
  return { session, host, run: (current = () => true) => method.call(host as unknown as WebServer, session, current) };
}
describe('explicit Discord recovery', () => {
  it.each(['available', 'unverified'])('does not restart an %s agent', async (state) => {
    const f = fixture({ state });
    expect(await f.run()).toBe(false);
    expect(f.session.resumeExitedRemote).not.toHaveBeenCalled();
    expect(f.session.reattachRemote).not.toHaveBeenCalled();
  });
  it('resumes a supported exact exit and preserves the same Session identity', async () => {
    const f = fixture({ state: 'agent_exited', canResume: true });
    expect(await f.run()).toBe(true);
    expect(f.session.resumeExitedRemote).toHaveBeenCalledOnce();
    expect(f.host.persistSessionState).toHaveBeenCalledWith(f.session);
  });
  it('reattaches only a confirmed-dead local proxy', async () => {
    const f = fixture({ state: 'connection_lost' });
    f.host.mux.isPaneDead.mockResolvedValue(false);
    expect(await f.run()).toBe(false);
    expect(f.session.reattachRemote).not.toHaveBeenCalled();
  });
  it('fences concurrent recovery attempts', async () => {
    const f = fixture({ state: 'agent_exited', canResume: true });
    let release!: (value: unknown) => void;
    const gate = new Promise((r) => {
      release = r;
    });
    f.host.discordHealth.check.mockReset().mockReturnValueOnce(gate).mockResolvedValue({ state: 'available' });
    const first = f.run();
    expect(await f.run()).toBe(false);
    release({ state: 'agent_exited', canResume: true });
    expect(await first).toBe(true);
    expect(f.session.resumeExitedRemote).toHaveBeenCalledOnce();
  });
  it('rechecks permission after asynchronous liveness validation', async () => {
    const f = fixture({ state: 'agent_exited', canResume: true });
    let allowed = true;
    f.host.discordHealth.check.mockReset().mockImplementationOnce(async () => {
      allowed = false;
      return { state: 'agent_exited', canResume: true };
    });
    expect(await f.run(() => allowed)).toBe(false);
    expect(f.session.resumeExitedRemote).not.toHaveBeenCalled();
  });
  it.each([true, false])('requires the Codex process resume ID after a recovery (%s)', async (matches) => {
    vi.spyOn(remoteIdentity, 'probeRemoteDiscordConversation').mockResolvedValue(matches ? conversation : undefined);
    const f = fixture({ state: 'agent_exited', canResume: true }, 'codex');
    expect(await f.run()).toBe(matches);
    expect(f.host.persistSessionState).toHaveBeenCalledTimes(matches ? 1 : 0);
  });
});
