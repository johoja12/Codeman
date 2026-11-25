/** Read-only runtime profile for an exact local managed Codex pane. No credential values leave the probe. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PythonInspectionWorker } from './python-inspection-worker.js';
import { resolveTmuxSocketName } from './config/instance.js';
import {
  REMOTE_CODEX_RUNTIME_PROBE,
  parseDiscordRuntime,
  type RemoteDiscordRuntime,
} from './discord-remote-conversation.js';
const execute = promisify(execFile);
let worker: PythonInspectionWorker | undefined;
export function closeDiscordInspectionWorkers(): void {
  worker?.close();
}

export async function probeLocalDiscordRuntime(
  session: {
    id: string;
    muxName: string | null;
    remote?: unknown;
    docker?: unknown;
  },
  socket = resolveTmuxSocketName()
): Promise<RemoteDiscordRuntime | undefined> {
  if (
    session.remote ||
    session.docker ||
    !/^[a-f0-9-]{36}$/i.test(session.id) ||
    session.muxName !== 'codeman-' + session.id.slice(0, 8)
  )
    return undefined;
  try {
    const args = JSON.stringify({ location: { socket, sessionName: session.muxName } });
    if (!process.env.VITEST) {
      worker ??= new PythonInspectionWorker(REMOTE_CODEX_RUNTIME_PROBE);
      const bytes = await worker.read([args]);
      return bytes ? parseDiscordRuntime(bytes) : undefined;
    }
    const { stdout } = await execute('python3', ['-c', REMOTE_CODEX_RUNTIME_PROBE, args], {
      encoding: 'buffer',
      timeout: 15000,
      maxBuffer: 16384,
    });
    return parseDiscordRuntime(stdout);
  } catch {
    return undefined;
  }
}
