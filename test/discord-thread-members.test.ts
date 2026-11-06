import { expect, it, vi } from 'vitest';
import { DiscordThreadMembers } from '../src/discord-thread-members.js';
const user = '111111111111111111',
  other = '222222222222222222';
function fixture() {
  let now = 1,
    live = true;
  const add = vi.fn(async () => undefined),
    verify = vi.fn(async () => true);
  const members = new DiscordThreadMembers(add, () => now);
  const target = {
    scope: 'guild/category/token/users',
    thread: '333333333333333333',
    users: [user],
    current: () => live,
    verify,
  };
  return {
    add,
    verify,
    members,
    target,
    advance: (n: number) => {
      now += n;
    },
    stop: () => {
      live = false;
    },
  };
}
it('coalesces, adds only allowed IDs once, caches success and reconciles after restart/reset', async () => {
  const { members, target, add, verify } = fixture();
  target.users.push(user, 'not-a-user');
  await Promise.all([members.ensure(target), members.ensure(target)]);
  expect(add).toHaveBeenCalledExactlyOnceWith(target.thread, user, target.current);
  await members.ensure(target);
  expect(add).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(1);
  members.reset();
  await members.ensure(target);
  expect(add).toHaveBeenCalledTimes(2);
  await members.ensure({ ...target, users: [user, other] });
  expect(add).toHaveBeenLastCalledWith(target.thread, other, target.current);
});
it('retries failures after backoff and continues adding the other configured members', async () => {
  const { members, target, add, advance } = fixture();
  target.users.push(other);
  add.mockRejectedValueOnce(new Error('403'));
  await expect(members.ensure(target)).rejects.toThrow('403');
  expect(add).toHaveBeenCalledTimes(2);
  await members.ensure(target);
  expect(add).toHaveBeenCalledTimes(2);
  advance(30001);
  await members.ensure(target);
  expect(add).toHaveBeenCalledTimes(3);
  advance(15 * 60000);
  await members.ensure(target);
  expect(add).toHaveBeenCalledTimes(5);
});
it('does not add users to unowned, archived, locked or obsolete destinations', async () => {
  const { members, target, add, verify, stop } = fixture();
  verify.mockResolvedValueOnce(false);
  await members.ensure(target);
  expect(add).not.toHaveBeenCalled();
  members.reset();
  verify.mockImplementationOnce(async () => {
    stop();
    return true;
  });
  await members.ensure(target);
  expect(add).not.toHaveBeenCalled();
});
it('serializes membership writes across threads and cancels queued work after a scope change', async () => {
  const { members, target, add, stop } = fixture();
  let release!: () => void;
  add.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const first = members.ensure(target);
  await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  const next = members.ensure({ ...target, thread: '444444444444444444' });
  stop();
  release();
  await Promise.all([first, next]);
  expect(add).toHaveBeenCalledTimes(1);
});
