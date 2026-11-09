/** Exercise the real remote file-reader script through a local subprocess; no SSH connection. */
import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const probe = vi.hoisted(() => ({ reads: 0 }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: object) => {
      if (command === 'ssh') {
        probe.reads++;
        return actual.spawn('sh', ['-c', args.at(-1)!], options);
      }
      return actual.spawn(command, args, options);
    },
  };
});
vi.mock('../src/remote-files.js', () => ({
  remoteProbePaths: async (_remote: unknown, paths: string[]) =>
    Promise.all(
      paths.map(async (path) => {
        const info = await stat(path);
        return { kind: info.isDirectory() ? 'directory' : 'file', realPath: await realpath(path), size: info.size };
      })
    ),
}));
import { readDiscordSessionFile, DiscordFileOutsideWorkspace } from '../src/discord-file-transfers.js';
beforeEach(() => {
  probe.reads = 0;
});
it('reads an approved SSH output as exact bytes, without granting its sibling or a symlink target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-remote-approval-'));
  try {
    const root = join(dir, 'workspace');
    await mkdir(root);
    const file = join(dir, 'PDF report.pdf'),
      other = join(dir, 'other.pdf'),
      alias = join(dir, 'alias.pdf');
    const bytes = Buffer.from([37, 80, 68, 70, 0, 255]);
    await writeFile(file, bytes);
    await writeFile(other, 'OTHER');
    await symlink(other, alias);
    const remote = {
      hostId: 'fixture',
      host: 'fixture.invalid',
      username: 'fixture',
      port: 22,
      remotePath: root,
      owned: true,
    };
    const scope = { workingDir: root, remote };
    await expect(readDiscordSessionFile(scope, file)).rejects.toBeInstanceOf(DiscordFileOutsideWorkspace);
    expect(probe.reads).toBe(0);
    expect((await readDiscordSessionFile(scope, file, { path: file })).data).toEqual(bytes);
    expect(probe.reads).toBe(1);
    await expect(readDiscordSessionFile(scope, other, { path: file })).rejects.toThrow('changed');
    await expect(readDiscordSessionFile(scope, alias, { path: alias })).rejects.toThrow('changed');
    expect(probe.reads).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('does not expose a credential file through a remote approval or a symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-remote-private-'));
  try {
    const root = join(dir, 'workspace');
    await mkdir(root);
    await mkdir(join(dir, '.ssh'));
    const key = join(dir, '.ssh', 'key.pdf');
    await writeFile(key, 'SECRET');
    const alias = join(dir, 'report.pdf');
    await symlink(key, alias);
    const remote = { hostId: 'fixture', host: 'fixture.invalid', username: 'fixture', remotePath: root, owned: true };
    await expect(readDiscordSessionFile({ workingDir: root, remote }, key, { path: key })).rejects.toThrow(
      'credentials'
    );
    await expect(readDiscordSessionFile({ workingDir: root, remote }, alias)).rejects.toThrow('credentials');
    expect(probe.reads).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
