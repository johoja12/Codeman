import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDiscordSessionHistory } from '../src/discord-history.js';
import * as profile from '../src/discord-remote-claude.js';
import * as files from '../src/discord-file-transfers.js';
import { Session } from '../src/session.js';
const id = '07be20d6-c98c-428d-9d40-17d8c935f6bd';
const local = '31b9d41b-f684-4cee-b165-a2191d8ff5a7';
const runtime = { id, configHome: '/home/guest/.claude', fingerprint: 'a'.repeat(64) };
afterEach(() => vi.restoreAllMocks());
function fixture(pin = local, firstHand = false) {
  const s = {
    id: local,
    mode: 'claude',
    claudeSessionId: pin,
    claudeSessionIdIsFirstHand: firstHand,
    remote: { host: 'worker', remoteSessionName: 'exact-pane' },
    envOverrideValue: () => undefined,
    adoptVerifiedRemoteClaudeResumeId: vi.fn((value: string) => {
      s.claudeSessionId = value;
    }),
  };
  vi.spyOn(profile, 'probeRemoteClaudeRuntime').mockResolvedValue(runtime);
  const read = vi.spyOn(files, 'runDiscordRemoteRead').mockResolvedValue(
    Buffer.from(
      JSON.stringify({
        offset: 0,
        partial: false,
        data: Buffer.from(
          JSON.stringify({ type: 'user', sessionId: firstHand ? pin : id, message: { content: 'fixture' } }) + '\n'
        ).toString('base64'),
      })
    )
  );
  return { s, read, run: () => readDiscordSessionHistory(s as unknown as Session) };
}
describe('remote Claude exact history binding', () => {
  it('adopts only a placeholder from the exact stable runtime and reads its own profile', async () => {
    const f = fixture();
    expect((await f.run()).conversationId).toBe(id);
    expect(f.s.adoptVerifiedRemoteClaudeResumeId).toHaveBeenCalledWith(id);
    expect(f.read.mock.calls[0][1]).toContain('/home/guest/.claude');
    expect(f.read.mock.calls[0][1]).toContain(id);
  });
  it('never replaces an existing non-placeholder pin with a different invocation', async () => {
    const f = fixture('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    await expect(f.run()).rejects.toThrow('profile');
    expect(f.read).not.toHaveBeenCalled();
    expect(f.s.adoptVerifiedRemoteClaudeResumeId).not.toHaveBeenCalled();
  });
  it('preserves first-hand post-clear hook identity over stale resume arguments', async () => {
    const pin = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const f = fixture(pin, true);
    expect((await f.run()).conversationId).toBe(pin);
    expect(f.s.adoptVerifiedRemoteClaudeResumeId).not.toHaveBeenCalled();
  });
  it('refuses a profile change during reading without adopting anything', async () => {
    const f = fixture();
    vi.mocked(profile.probeRemoteClaudeRuntime)
      .mockReset()
      .mockResolvedValueOnce(runtime)
      .mockResolvedValue({ ...runtime, fingerprint: 'b'.repeat(64) });
    await expect(f.run()).rejects.toThrow('profile');
    expect(f.s.adoptVerifiedRemoteClaudeResumeId).not.toHaveBeenCalled();
  });
  it('refuses a remote pane changing during reading', async () => {
    const f = fixture();
    f.read.mockImplementation(async () => {
      f.s.remote.remoteSessionName = 'different-pane';
      return Buffer.from('{"offset":0,"partial":false,"data":""}');
    });
    await expect(f.run()).rejects.toThrow('profile');
    expect(f.s.adoptVerifiedRemoteClaudeResumeId).not.toHaveBeenCalled();
  });
});

it('persists a verified resume without inventing a hook or accepting a foreign pin', () => {
  const s = new Session({
    id: local,
    workingDir: '/tmp',
    mode: 'claude',
    useMux: false,
    remote: { hostId: 'fixture', host: 'test.invalid', username: 'test', port: 22, remotePath: '/tmp', owned: true },
  });
  expect(s.adoptVerifiedRemoteClaudeResumeId(id)).toBe(true);
  expect(s.toState().claudeSessionId).toBe(id);
  expect(s.claudeSessionIdIsFirstHand).toBe(false);
  expect(s.adoptVerifiedRemoteClaudeResumeId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(false);
  s.adoptClaudeSessionStartId(local);
  expect(s.adoptVerifiedRemoteClaudeResumeId(id)).toBe(false);
});

it.each(['keyboard input', 'terminal resize'])('preserves a verified Claude transcript during %s', async () => {
  const f = fixture(id, true);
  Object.assign(f.s, { inspectionGeneration: 'pane-owner-1', nativeModelSettingsRevision: 'input-geometry-1' });
  f.read.mockImplementation(async () => {
    Object.assign(f.s, { nativeModelSettingsRevision: 'input-geometry-2' });
    return Buffer.from(
      JSON.stringify({
        offset: 0,
        partial: false,
        data: Buffer.from(
          JSON.stringify({ type: 'user', sessionId: id, message: { content: 'fixture' } }) + '\n'
        ).toString('base64'),
      })
    );
  });
  await expect(f.run()).resolves.toHaveProperty('conversationId', id);
  expect(f.s.adoptVerifiedRemoteClaudeResumeId).not.toHaveBeenCalled();
});
