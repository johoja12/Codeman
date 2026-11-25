import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: fake.spawn,
}));
import {
  runDiscordRemoteRead,
  closeDiscordReadConnections,
  DISCORD_FILE_LIMIT,
} from '../src/discord-file-transfers.js';
const remote = {
  hostId: 'fixture',
  label: 'fixture',
  host: 'worker.example',
  username: 'fixture',
  remotePath: '/workspace',
};
const children: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
function respond(data: Buffer, stderr = Buffer.alloc(0), code = 0) {
  fake.spawn.mockImplementation((_file, _argv) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    children.push(child);
    queueMicrotask(() => {
      child.stdout.emit('data', data);
      if (stderr.length) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  });
}
afterAll(() => closeDiscordReadConnections());
it('preserves exact binary bytes and reuses only the same remote object/configuration', async () => {
  respond(Buffer.from([0, 255, 10]));
  expect(await runDiscordRemoteRead(remote, 'read')).toEqual(Buffer.from([0, 255, 10]));
  await runDiscordRemoteRead(remote, 'read again');
  await runDiscordRemoteRead({ ...remote }, 'other owner');
  const paths = fake.spawn.mock.calls.map((call) =>
    (call[1] as string[]).find((value) => value.startsWith('ControlPath='))
  );
  expect(paths[0]).toBeTruthy();
  expect(paths[1]).toBe(paths[0]);
  expect(paths[2]).not.toBe(paths[0]);
});
it('preserves the original byte and stderr bounds with pooled transport', async () => {
  respond(Buffer.alloc(DISCORD_FILE_LIMIT + 1));
  await expect(runDiscordRemoteRead(remote, 'large')).rejects.toThrow('8 MB');
  expect(children.at(-1)!.kill).toHaveBeenCalledWith('SIGTERM');
  respond(Buffer.alloc(0), Buffer.alloc(65537));
  await expect(runDiscordRemoteRead(remote, 'stderr')).rejects.toThrow('failed');
});
it('keeps explicit user SSH control settings and rejects failed channels', async () => {
  respond(Buffer.alloc(0), Buffer.alloc(0), 255);
  await expect(
    runDiscordRemoteRead({ ...remote, extraSshOptions: ['ControlPath=/user/socket'] }, 'read')
  ).rejects.toThrow('safely');
  const argv = fake.spawn.mock.calls.at(-1)![1] as string[];
  expect(argv).toContain('ControlPath=/user/socket');
  expect(argv).not.toContain('ControlMaster=auto');
});
