/** Canonical Discord history, with one guarded native status read for an unbound remote Codex pane. */
import { posix } from 'node:path';
import type { Session } from './session.js';
import { getCli } from './config/cli-registry/registry.js';
import { readDiscordHistory, readDiscordSessionHistory, type DiscordHistory } from './discord-history.js';
import { readCodexModelStatus, nativeModelComposerReady } from './discord-model-controls.js';
import { stripAnsi } from './utils/regex-patterns.js';
const attempts = new WeakMap<Session, { retryAt: number; run: Promise<DiscordHistory> }>();
export async function readDiscordCanonicalHistory(
  session: Session,
  options: { includeTools?: boolean } = {},
  permitted: () => boolean = () => false
): Promise<DiscordHistory> {
  try {
    return await readDiscordSessionHistory(session, options);
  } catch (original) {
    const cli = getCli(session.mode);
    if (
      !permitted() ||
      !session.remote ||
      session.nativeResumeId ||
      session.codexConfig?.resumeSessionId ||
      cli?.capabilities.transcript !== 'codex-rollout' ||
      cli.capabilities.nativeSettingsProfile !== 'codex-tui' ||
      session.isWorking ||
      session.paneExit ||
      typeof session.withNativeModelSettings !== 'function'
    )
      throw original;
    const previous = attempts.get(session);
    if (previous && previous.retryAt > Date.now()) {
      await previous.run;
      return readDiscordSessionHistory(session, options);
    }
    const remote = session.remote,
      revision = session.nativeModelSettingsRevision;
    const allowed = () =>
      permitted() &&
      session.remote === remote &&
      session.nativeModelSettingsRevision === revision &&
      !session.isWorking &&
      !session.paneExit &&
      !session.nativeResumeId;
    const run = session.withNativeModelSettings(async (lease) => {
      const before = await lease.capture();
      if (!allowed() || !lease.current() || !nativeModelComposerReady(session.mode, before)) throw original;
      // A CLI-local status command: never a model prompt, model change or unguarded terminal write.
      if (!(await lease.write('/status\r'))) throw original;
      for (let i = 0; i < 30; i++) {
        if (!allowed() || !lease.current()) throw new Error('Conversation/input changed during transcript recovery');
        const raw = await lease.capture();
        if (raw !== before && nativeModelComposerReady(session.mode, raw)) {
          const text = stripAnsi(raw)
            .replace(/^\s*[›❯]\s+(\/status)\s*$/gm, '$1')
            .replace(/^\s*[│┃]\s?/gm, '')
            .replace(/\s*[│┃]\s*$/gm, '');
          const status = readCodexModelStatus(text);
          if (status && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(status.session)) {
            let configHome = session.envOverrideValue('CODEX_HOME');
            if (configHome && !configHome.startsWith('~/') && !posix.isAbsolute(configHome))
              configHome = posix.resolve(remote.remotePath, configHome);
            const history = await readDiscordHistory({
              mode: session.mode,
              conversationId: status.session,
              remote,
              configHome,
              includeTools: options.includeTools,
            });
            if (!allowed() || !lease.current() || history.conversationId !== status.session)
              throw new Error('Conversation changed during transcript recovery');
            session.setNativeResumeId(status.session);
            return history;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Native status did not confirm an exact conversation; transcript remains unavailable');
    }, allowed);
    attempts.set(session, { retryAt: Date.now() + 60000, run });
    return run;
  }
}
