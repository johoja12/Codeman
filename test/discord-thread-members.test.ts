import { expect, it, vi } from 'vitest';
import { DiscordThreadMembers } from '../src/discord-thread-members.js';
const user = '637753932856426546',
  thread = '1572283661066174516';
function fixture() {
  let now = 1000,
    scope: string | undefined = 'scope',
    users = [user],
    live = true;
  const host = {
    scope: () => scope,
    users: () => users,
    current: () => live,
    verify: vi.fn(async () => true),
    add: vi.fn(async () => {}),
    now: () => now,
  };
  return {
    host,
    m: new DiscordThreadMembers(host),
    advance: (n: number) => (now += n),
    scope: (s: string | undefined) => (scope = s),
    users: (u: string[]) => (users = u),
    live: (v: boolean) => (live = v),
  };
}
it('adds a configured user idempotently and periodically reconciles membership', async () => {
  const f = fixture();
  await Promise.all([f.m.ensure('s', thread), f.m.ensure('s', thread)]);
  expect(f.host.add).toHaveBeenCalledTimes(1);
  await f.m.ensure('s', thread);
  expect(f.host.verify).toHaveBeenCalledTimes(1);
  f.advance(300001);
  await f.m.ensure('s', thread);
  expect(f.host.add).toHaveBeenCalledTimes(2);
});
it('retries a failed membership request with backoff without recreating anything', async () => {
  const f = fixture();
  f.host.add.mockRejectedValueOnce(new Error('forbidden'));
  await f.m.ensure('s', thread);
  await f.m.ensure('s', thread);
  expect(f.host.add).toHaveBeenCalledTimes(1);
  f.advance(30001);
  await f.m.ensure('s', thread);
  expect(f.host.add).toHaveBeenCalledTimes(2);
});
it('never adds users to archived, locked or unowned destinations', async () => {
  const f = fixture();
  f.host.verify.mockResolvedValue(false);
  await f.m.ensure('s', thread);
  await f.m.ensure('s', thread);
  expect(f.host.add).not.toHaveBeenCalled();
  expect(f.host.verify).toHaveBeenCalledTimes(1);
});
it.each(['scope', 'user', 'session'])('rechecks %s after async ownership verification', async (change) => {
  const f = fixture();
  f.host.verify.mockImplementationOnce(async () => {
    if (change === 'scope') f.scope('new');
    if (change === 'user') f.users([]);
    if (change === 'session') f.live(false);
    return true;
  });
  await f.m.ensure('s', thread);
  expect(f.host.add).not.toHaveBeenCalled();
});
it('does nothing when the bridge is disabled and handles invalid user IDs', async () => {
  const f = fixture();
  f.scope(undefined);
  await f.m.ensure('s', thread);
  expect(f.host.verify).not.toHaveBeenCalled();
  f.scope('scope');
  f.users(['bad']);
  await f.m.ensure('s', thread);
  expect(f.host.add).not.toHaveBeenCalled();
});
