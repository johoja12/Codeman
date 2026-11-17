import { beforeEach, expect, it, vi } from 'vitest';
const call = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const fn = () => undefined;
  Object.defineProperty(fn, promisify.custom, { value: call });
  return { ...actual, execFile: fn };
});
import { probeLocalDiscordRuntime } from '../src/discord-local-conversation.js';
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({
    stdout: Buffer.from(
      JSON.stringify({ configHome: '/home/test/custom account', fingerprint: 'a'.repeat(64), id: null })
    ),
  });
});
it('targets only the owned instance socket/pane and returns profile metadata without inventing an ID', async () => {
  expect(await probeLocalDiscordRuntime({ id, muxName: 'codeman-aaaaaaaa' }, 'codeman-beta')).toEqual({
    configHome: '/home/test/custom account',
    fingerprint: 'a'.repeat(64),
    id: undefined,
  });
  expect(call).toHaveBeenCalledTimes(1);
  const args = call.mock.calls[0][1];
  expect(JSON.parse(args[2])).toEqual({ location: { socket: 'codeman-beta', sessionName: 'codeman-aaaaaaaa' } });
});
it.each([
  { id, muxName: 'other-pane' },
  { id, muxName: 'codeman-aaaaaaaa', remote: {} },
  { id, muxName: 'codeman-aaaaaaaa', docker: {} },
  { id: 'invalid', muxName: 'codeman-invalid' },
])('does not probe an unowned or non-local pane %j', async (session) => {
  expect(await probeLocalDiscordRuntime(session)).toBeUndefined();
  expect(call).not.toHaveBeenCalled();
});
it.each([
  { id: null },
  { configHome: '/profile', fingerprint: 'bad' },
  { configHome: 'relative', fingerprint: 'a'.repeat(64) },
])('refuses unverifiable runtime metadata %j', async (packet) => {
  call.mockResolvedValue({ stdout: Buffer.from(JSON.stringify(packet)) });
  expect(await probeLocalDiscordRuntime({ id, muxName: 'codeman-aaaaaaaa' })).toBeUndefined();
});
