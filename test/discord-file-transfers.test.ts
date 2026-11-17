/** Real local subprocess tests for the SSH reader script; never connects to SSH or Discord. */
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import {
  discordRemoteReadCommand,
  boundedDiscordDownload,
  DISCORD_FILE_LIMIT,
  readDiscordSessionFile,
  DiscordFileOutsideWorkspace,
} from '../src/discord-file-transfers.js';
const exec = promisify(execFile);
describe('guarded Discord binary transfer', () => {
  it('reads exact binary bytes with spaces and rejects leaf and parent symlinks, escape and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discord-files-'));
    try {
      await mkdir(join(root, 'a b'));
      const file = join(root, 'a b', 'résumé.bin');
      const bytes = Buffer.from([0, 255, 13, 10, 34]);
      await writeFile(file, bytes);
      const read = (path: string, max = 100) =>
        exec('sh', ['-c', discordRemoteReadCommand(root, path, max)], { encoding: 'buffer' });
      expect((await read(file)).stdout).toEqual(bytes);
      await symlink(file, join(root, 'leaf'));
      await symlink(join(root, 'a b'), join(root, 'parent'));
      await expect(read(join(root, 'leaf'))).rejects.toThrow();
      await expect(read(join(root, 'parent', 'résumé.bin'))).rejects.toThrow();
      await expect(read(join(root, '..', 'outside'))).rejects.toThrow();
      await expect(read(file, 2)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('bounds streamed bytes even with a false declared length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(DISCORD_FILE_LIMIT));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    await expect(boundedDiscordDownload(new Response(stream, { headers: { 'Content-Length': '1' } }))).rejects.toThrow(
      '8 MB'
    );
    expect(await boundedDiscordDownload(new Response(Buffer.from([1, 0, 2])))).toEqual(Buffer.from([1, 0, 2]));
  });
});

it('requires an exact one-file approval outside the workspace and keeps other paths closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-file-approval-'));
  const root = join(dir, 'workspace'),
    report = join(dir, 'report.pdf'),
    sibling = join(dir, 'other.pdf');
  try {
    await mkdir(root);
    await writeFile(report, 'PDF');
    await writeFile(sibling, 'OTHER');
    const refused = await readDiscordSessionFile({ workingDir: root }, report).catch((e) => e);
    expect(refused).toBeInstanceOf(DiscordFileOutsideWorkspace);
    expect(refused).toMatchObject({ path: report, size: 3 });
    expect((await readDiscordSessionFile({ workingDir: root }, report, { path: report })).data).toEqual(
      Buffer.from('PDF')
    );
    await expect(readDiscordSessionFile({ workingDir: root }, sibling, { path: report })).rejects.toThrow('changed');
    await expect(readDiscordSessionFile({ workingDir: root }, sibling)).rejects.toBeInstanceOf(
      DiscordFileOutsideWorkspace
    );
    await symlink(sibling, join(dir, 'alias.pdf'));
    await expect(
      readDiscordSessionFile({ workingDir: root }, join(dir, 'alias.pdf'), { path: join(dir, 'alias.pdf') })
    ).rejects.toThrow('changed');
    await writeFile(report, Buffer.alloc(DISCORD_FILE_LIMIT + 1));
    await expect(readDiscordSessionFile({ workingDir: root }, report, { path: report })).rejects.toThrow('8 MB');
    await rm(report);
    await expect(readDiscordSessionFile({ workingDir: root }, report, { path: report })).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('never offers or honors an external approval for credential paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-private-approval-'));
  try {
    const root = join(dir, 'workspace');
    await mkdir(root);
    await mkdir(join(dir, '.ssh'));
    const secret = join(dir, '.ssh', 'key.pdf');
    await writeFile(secret, 'SECRET');
    await expect(readDiscordSessionFile({ workingDir: root }, secret)).rejects.toThrow('credentials');
    await expect(readDiscordSessionFile({ workingDir: root }, secret, { path: secret })).rejects.toThrow('credentials');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
