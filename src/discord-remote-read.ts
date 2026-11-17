/** Bounded read-only SSH transport. Never returns remote stderr or changes remote files. */
import { spawn } from 'node:child_process';
import { buildSshConnectionArgv, remoteSshTarget } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';
import type { SessionRemote } from './types/session.js';
const DISCORD_READ_LIMIT = 8 * 1024 * 1024;
export class DiscordRemoteReadError extends Error {}
export async function runDiscordRemoteRead(remote: SessionRemote, command: string): Promise<Buffer> {
  return runWithRemoteSshLimit(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        const child = spawn('ssh', [...buildSshConnectionArgv(remote), remoteSshTarget(remote), command], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let bytes = 0,
          stderr = 0,
          settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            child.kill('SIGTERM');
            reject(err);
          } else resolve(Buffer.concat(chunks));
        };
        const timer = setTimeout(() => finish(new DiscordRemoteReadError('Remote file transfer timed out')), 30000);
        child.stdout.on('data', (data: Buffer) => {
          if (settled) return;
          bytes += data.length;
          if (bytes > DISCORD_READ_LIMIT) finish(new DiscordRemoteReadError('The file is over 8 MB'));
          else chunks.push(Buffer.from(data));
        });
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.length;
          if (stderr > 65536) finish(new DiscordRemoteReadError('Remote file transfer failed'));
        });
        child.on('error', () => finish(new DiscordRemoteReadError('Remote file transfer failed')));
        child.on('close', (code) =>
          finish(code === 0 ? undefined : new DiscordRemoteReadError('Remote file could not be read safely'))
        );
      })
  );
}
