/** Execute only a fake SSH/tmux pair; a vanished worker must not create an agent. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildRemoteLaunchCommand } from '../src/tmux-manager.js';
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
it.each(['claude', 'codex'] as const)(
  'propagates a missing %s worker without a create or CLI fallback',
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), 'discord-attach-'));
    dirs.push(dir);
    const bin = join(dir, 'bin'),
      log = join(dir, 'calls');
    await mkdir(bin);
    await writeFile(
      join(bin, 'ssh'),
      '#!/bin/sh\nfor arg do last=$arg; done\ntmux() { printf "%s\\n" "$*" >> "$CODEMAN_TEST_ATTACH_LOG"; return 47; }\neval "$last"\n',
      { mode: 0o700 }
    );
    const command = buildRemoteLaunchCommand({
      mode,
      attachOnly: true,
      sessionId: '11111111-1111-4111-8111-111111111111',
      remote: {
        hostId: 'fixture',
        host: 'worker.invalid',
        username: 'fixture',
        remotePath: '/workspace with spaces',
        port: 2222,
        jumpHost: 'jump.invalid',
      },
    });
    await expect(
      exec('/bin/sh', ['-c', command], {
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, CODEMAN_TEST_ATTACH_LOG: log },
        timeout: 2000,
      })
    ).rejects.toMatchObject({ code: 47 });
    const calls = await readFile(log, 'utf8');
    expect(calls).toContain('-L codeman-remote attach-session -t codeman-ssh-11111111');
    expect(calls).not.toMatch(/new-session|respawn|--resume|--session-id/);
  }
);
