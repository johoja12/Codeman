/** Display-only conversation evidence from an already authorized canonical history read. */
import type { Session } from './session.js';

type ActivitySession = Pick<
  Session,
  | 'mode'
  | 'workingDir'
  | 'remote'
  | 'docker'
  | 'nativeResumeId'
  | 'claudeSessionId'
  | 'codexConfig'
  | 'discordQueueRevision'
  | 'nativeModelSettingsRevision'
  | 'lastSubmitAt'
  | 'envOverrideValue'
>;

/** Never persisted or used as input/approval authority. Rebuild after restart from fresh reads. */
export class DiscordActivityIdentities {
  private readonly entries = new WeakMap<ActivitySession, { scope: string; conversation: string }>();

  scope(session: ActivitySession): string {
    const remote = session.remote;
    return JSON.stringify([
      session.mode,
      session.workingDir,
      !!session.docker,
      remote && [
        remote.hostId,
        remote.host,
        remote.port,
        remote.username,
        remote.remotePath,
        remote.owned,
        remote.codexCommandProfileId,
        remote.commands?.codex,
      ],
      session.nativeResumeId,
      session.claudeSessionId,
      session.codexConfig?.resumeSessionId,
      session.discordQueueRevision,
      session.nativeModelSettingsRevision,
      session.lastSubmitAt,
      session.envOverrideValue('CODEX_HOME') ?? (!remote ? process.env.CODEX_HOME : undefined),
      session.envOverrideValue('CLAUDE_CONFIG_DIR') ?? (!remote ? process.env.CLAUDE_CONFIG_DIR : undefined),
    ]);
  }

  remember(session: ActivitySession, before: string, conversation: string): void {
    if (before === this.scope(session)) this.entries.set(session, { scope: before, conversation });
    else this.forget(session);
  }

  get(session: ActivitySession): string | undefined {
    const entry = this.entries.get(session);
    if (entry?.scope === this.scope(session)) return entry.conversation;
    this.forget(session);
    return undefined;
  }

  forget(session: ActivitySession): void {
    this.entries.delete(session);
  }
}
