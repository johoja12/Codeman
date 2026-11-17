/** Read-only Discord liveness; a dead SSH client is not an authoritative remote-agent exit. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTmuxSocketName } from '../config/instance.js';
import { probeRemoteWorker, type RemoteWorkerObservation } from '../remote-hosts.js';
import type { DiscordSessionView as Session } from '../discord-session-view.js';
import type { DiscordConnection } from '../discord-native-ui-types.js';
const exec = promisify(execFile);
export type PaneLiveness = 'alive' | 'dead' | 'unknown';
export async function probeDiscordPane(name: string): Promise<PaneLiveness> {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return 'unknown';
  try {
    const { stdout } = await exec(
      'tmux',
      ['-L', resolveTmuxSocketName(), 'display-message', '-p', '-t', `=${name}:`, '#{pane_dead}:#{pane_pid}'],
      { encoding: 'utf8', timeout: 4000 }
    );
    return /^0:\d+\s*$/.test(stdout) ? 'alive' : /^1:\d+\s*$/.test(stdout) ? 'dead' : 'unknown';
  } catch {
    return 'unknown';
  }
}
interface Deps {
  /** Host must provide an exact, no-fallback resume implementation before exposing Resume. */
  canResume?(session: Session): boolean;
  paneExited(name: string): boolean;
  local?(name: string): Promise<PaneLiveness>;
  remote?(session: Session): Promise<RemoteWorkerObservation | undefined>;
  verify?(session: Session): Promise<boolean>;
  now?(): number;
}
export class DiscordSessionHealth {
  private cache = new WeakMap<Session, { key: string; at: number; value: DiscordConnection }>();
  private checking = new WeakMap<Session, Promise<DiscordConnection>>();
  constructor(private readonly deps: Deps) {}
  private key(s: Session): string {
    return JSON.stringify([
      s.muxName,
      s.paneLifecycleInFlight,
      s.nativeResumeId,
      s.claudeSessionId,
      s.remote,
      !!s.paneExit,
      s.muxName ? this.deps.paneExited(s.muxName) : false,
    ]);
  }
  invalidate(s: Session): void {
    this.cache.delete(s);
  }
  peek(s: Session): DiscordConnection {
    if (s.paneLifecycleInFlight) return { state: 'unverified' };
    const saved = this.cache.get(s);
    if (saved?.key === this.key(s)) return saved.value;
    if (s.paneExit) return { state: 'agent_exited' };
    if (s.muxName && this.deps.paneExited(s.muxName)) return { state: s.remote ? 'connection_lost' : 'agent_exited' };
    return { state: 'available' };
  }
  check(s: Session, fresh = false): Promise<DiscordConnection> {
    const pending = this.checking.get(s);
    if (pending) return fresh ? pending : Promise.resolve(this.peek(s));
    const run = this.checkNow(s, fresh)
      .catch(() => ({ state: 'unverified' as const }))
      .finally(() => {
        if (this.checking.get(s) === run) this.checking.delete(s);
      });
    this.checking.set(s, run);
    // Polling must not hold every session card behind an unreachable host.
    return !fresh && s.remote ? Promise.resolve(this.peek(s)) : run;
  }
  private async checkNow(s: Session, fresh: boolean): Promise<DiscordConnection> {
    const key = this.key(s),
      now = this.deps.now?.() ?? Date.now(),
      saved = this.cache.get(s);
    if (!fresh && this.peek(s).state === 'available' && (!s.remote || (saved?.key === key && now - saved.at < 30000)))
      return { state: 'available' };
    if (!fresh && saved?.key === key && now - saved.at < 10000) return saved.value;
    const local = s.muxName
      ? await (this.deps.local ?? probeDiscordPane)(s.muxName).catch(() => 'unknown' as const)
      : (() => {
          if (!s.pid) return 'unknown' as const;
          try {
            process.kill(s.pid, 0);
            return 'alive' as const;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ESRCH' ? ('dead' as const) : ('unknown' as const);
          }
        })();
    let value: DiscordConnection;
    if (s.paneLifecycleInFlight) value = { state: 'unverified' };
    else if (s.remote) {
      const remote = await (
        this.deps.remote
          ? this.deps.remote(s)
          : probeRemoteWorker(s.remote, s.remote.remoteSessionName ?? `codeman-ssh-${s.id.slice(0, 8)}`)
      ).catch(() => undefined);
      if (!remote) value = { state: 'unverified' };
      else if (!remote.alive || remote.agentRunning === false) {
        const pinned = this.deps.canResume?.(s) ?? false;
        value = { state: 'agent_exited', canResume: !remote.alive && local === 'dead' && !!pinned && !s.isAdopted };
      } else
        value = {
          state: remote.agentRunning !== true ? 'unverified' : local === 'alive' ? 'available' : 'connection_lost',
        };
    } else
      value = {
        state:
          local === 'dead'
            ? s.docker
              ? 'connection_lost'
              : 'agent_exited'
            : local === 'alive'
              ? 'available'
              : 'unverified',
      };
    if (value.state === 'available' && this.deps.verify) {
      // A history read can race fresh input or a transient transport error. Require a fresh
      // successful verification rather than promoting one failed read to a persistent warning.
      let verified = false;
      for (let attempt = 0; attempt < 2 && !verified; attempt++) {
        verified = await this.deps.verify(s).catch(() => false);
        if (key !== this.key(s)) return { state: 'unverified' };
      }
      if (!verified) value = { state: 'unverified' };
    }
    if (key !== this.key(s)) return { state: 'unverified' };
    this.cache.set(s, { key, at: this.deps.now?.() ?? Date.now(), value });
    return value;
  }
}
