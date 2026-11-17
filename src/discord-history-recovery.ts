import { nativeCodexStatusComposerReady } from './native-composer-ready.js';
/** @fileoverview Canonical Discord history, with one guarded native status read for an unbound Codex pane. */
import type { Session } from './session.js';
import { getCli } from './config/cli-registry/registry.js';
import { readDiscordSessionHistory, DiscordHistoryReadError, type DiscordHistory } from './discord-history.js';
import { readCodexModelStatus, nativeModelComposerReady } from './discord-model-controls.js';
import { stripAnsi } from './utils/regex-patterns.js';
const attempts = new WeakMap<Session, { retryAt: number; run: Promise<DiscordHistory> }>();
export async function readDiscordCanonicalHistory(
  session: Session,
  options: { includeTools?: boolean; after?: string } = {},
  permitted: () => boolean = () => false
): Promise<DiscordHistory> {
  try {
    return await readDiscordSessionHistory(session, options);
  } catch (original) {
    const cli = getCli(session.mode);
    if (
      (original instanceof DiscordHistoryReadError &&
        ['profile_unverified', 'profile_changed'].includes(original.code)) ||
      !permitted() ||
      !!session.docker ||
      (session.blocksIdleAutomation && typeof session.withNativeStatusRead !== 'function') ||
      !!session.watching?.trim() ||
      session.nativeResumeId ||
      session.codexConfig?.resumeSessionId ||
      cli?.capabilities.transcript !== 'codex-rollout' ||
      cli.capabilities.nativeSettingsProfile !== 'codex-tui' ||
      (session.isWorking && typeof session.withNativeStatusRead !== 'function') ||
      session.paneExit ||
      (typeof session.withNativeModelSettings !== 'function' && typeof session.withNativeStatusRead !== 'function')
    )
      throw original;
    const previous = attempts.get(session);
    if (previous && previous.retryAt > Date.now()) {
      await previous.run;
      return readDiscordSessionHistory(session, options);
    }
    const statusOnly = typeof session.withNativeStatusRead === 'function';
    const ready = (raw: string) =>
      statusOnly ? nativeCodexStatusComposerReady(session.mode, raw) : nativeModelComposerReady(session.mode, raw);
    const withStatus = statusOnly
      ? session.withNativeStatusRead.bind(session)
      : session.withNativeModelSettings.bind(session);
    const remote = session.remote,
      revision = session.nativeModelSettingsRevision,
      home = session.envOverrideValue('CODEX_HOME');
    const allowed = () =>
      permitted() &&
      session.remote === remote &&
      session.envOverrideValue('CODEX_HOME') === home &&
      (statusOnly || !session.blocksIdleAutomation) &&
      !session.watching?.trim() &&
      session.nativeModelSettingsRevision === revision &&
      (statusOnly || !session.isWorking) &&
      !session.paneExit &&
      !session.nativeResumeId;
    const run = withStatus(async (lease) => {
      const before = await lease.capture();
      if (!allowed() || !lease.current() || !ready(before)) throw original;
      // A CLI-local status command: never a model prompt, model change or unguarded terminal write.
      if (
        !readCodexModelStatus(
          stripAnsi(before)
            .replace(/^\s*[›❯]\s+(\/status)\s*$/gm, '$1')
            .replace(/^\s*[│┃]\s?/gm, '')
            .replace(/\s*[│┃]\s*$/gm, '')
        ) &&
        !(await lease.write('/status\r'))
      )
        throw original;
      for (let i = 0; i < 30; i++) {
        if (!allowed() || !lease.current()) throw new Error('Conversation/input changed during transcript recovery');
        const raw = await lease.capture();
        if (ready(raw)) {
          const text = stripAnsi(raw)
            .replace(/^\s*[›❯]\s+(\/status)\s*$/gm, '$1')
            .replace(/^\s*[│┃]\s?/gm, '')
            .replace(/\s*[│┃]\s*$/gm, '');
          const status = readCodexModelStatus(text);
          if (status && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(status.session)) {
            const history = await readDiscordSessionHistory(session, options, status.session);
            const after = await lease.capture();
            const confirmed = readCodexModelStatus(
              stripAnsi(after)
                .replace(/^\s*[›❯]\s+(\/status)\s*$/gm, '$1')
                .replace(/^\s*[│┃]\s?/gm, '')
                .replace(/\s*[│┃]\s*$/gm, '')
            );
            if (
              !allowed() ||
              !lease.current() ||
              history.conversationId !== status.session ||
              confirmed?.session !== status.session
            )
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
