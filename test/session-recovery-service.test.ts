import { describe, expect, it, vi } from 'vitest';
import { probeRemoteRecoveryTarget } from '../src/remote-hosts.js';
import { recoveryRemoteIsLive, resolveRecoveryTransport } from '../src/web/session-recovery-service.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';

vi.mock('../src/remote-hosts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote-hosts.js')>()),
  readRemoteHosts: vi.fn(async () => [{ id: 'worker', label: 'Worker', host: 'example.test', username: 'alice' }]),
  readRemoteCases: vi.fn(async () => [{ hostId: 'worker', name: 'project', remotePath: '/work', owner: 'alice' }]),
  probeRemoteRecoveryTarget: vi.fn(async () => true),
}));

describe('repeated remote recovery', () => {
  it('resolves and probes the original remote pane after the local wrapper ID changes', async () => {
    const record: SessionRecoveryRecord = {
      id: 'recovery-second-wrapper',
      sourceSessionId: 'second-wrapper',
      owner: 'alice',
      mode: 'claude',
      workingDir: '/work',
      transport: 'remote',
      remote: { hostId: 'worker', owned: true, remoteSessionName: 'codeman-ssh-original' },
      status: 'reattachable',
      launch: { kind: 'built-in' },
      createdAt: 1,
    };
    const { remote } = await resolveRecoveryTransport(record);
    expect(remote).toMatchObject({ owned: true, remoteSessionName: 'codeman-ssh-original' });
    expect(await recoveryRemoteIsLive(record, remote!)).toBe(true);
    expect(probeRemoteRecoveryTarget).toHaveBeenCalledWith(
      remote,
      expect.objectContaining({ owned: true, remoteSessionName: 'codeman-ssh-original' })
    );
  });
});
