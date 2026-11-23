import { codexQueuedQuestionCount } from './codex-queued-question.js';
import {
  parseClaudeVisibleQuestion,
  parseClaudeHookConfirmation,
  parseClaudeCompactionPrompt,
  claudeQuestionGone,
} from './claude-visible-question.js';
import type { ApprovalItem } from './approval-inbox.js';
import { claudePromptSuggestion } from '../session-submit-verifier.js';
import { discordActivityWorking } from '../discord-activity.js';
import { getCli } from '../config/cli-registry/registry.js';
/** Server adapters for native Discord UI. Reuses settings, approval and file/SSH guards. */
import { approvalInbox } from './approval-inbox.js';
import { answerPendingApproval } from './routes/approval-routes.js';
import { discordApprovalRevision } from '../discord-task-controls.js';
import { readJsonConfig, SETTINGS_PATH } from './route-helpers.js';
import { SettingsUpdateSchema } from './schemas.js';
import { mutateSettingsFile } from './settings-writer.js';
import { discordWorkspaceResults, discordWorkspaceHasChanges } from '../discord-workspace-results.js';
import {
  configuredDiscordCaseKey,
  configuredDiscordCaseChannel,
  resolveDiscordCase,
} from '../discord-case-identity.js';
import type { DiscordNativeUiServices, DiscordConnection, DiscordUiSession } from '../discord-native-ui-types.js';
import type { Session } from '../session.js';
import type { CaseInfo } from '../types.js';
interface Deps {
  sessions(): Map<string, Session>;
  health?(s: Session, fresh?: boolean): Promise<DiscordConnection>;
  recover?(s: Session, current: () => boolean): Promise<boolean>;
  cases(): Promise<CaseInfo[]>;
  allowed(): boolean;
  url(): string | undefined;
  capture?(id: string): string | null | undefined | Promise<string | null | undefined>;
  activityConversation?(session: Session): string | undefined;
  questionObserved?(item: ApprovalItem): boolean | void | Promise<boolean | void>;
  observed?(id: string): { model: string; effort?: string } | undefined;
}
/** Deadlines apply only to observations; late reads cannot publish or submit input. */
export const DISCORD_OBSERVATION_TIMEOUT_MS = 30000;
function observedRead<T>(read: () => T | Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), DISCORD_OBSERVATION_TIMEOUT_MS);
    timer.unref?.();
    Promise.resolve()
      .then(read)
      .then(resolve, () => resolve(fallback))
      .finally(() => clearTimeout(timer));
  });
}
/** Match the native history reader: Claude IDs do not live in Codex resume fields. */
const conversationFor = (s: Session): string | undefined =>
  getCli(s.mode)?.capabilities.transcript === 'claude-jsonl'
    ? (s.claudeSessionId ?? undefined)
    : (s.nativeResumeId ?? s.codexConfig?.resumeSessionId);
export function createDiscordNativeUiServices(deps: Deps): DiscordNativeUiServices {
  const session = (id: string) => {
    const s = deps.sessions().get(id);
    if (!deps.allowed() || !s || s.suppressNotifications) throw new Error('Session unavailable');
    return s;
  };
  const working = (s: Session) =>
    discordActivityWorking({
      id: s.id,
      working: s.isWorking,
      watching: s.watching,
      activityStatus: s.activityProjection?.activityStatus,
    });
  const observed = new Map<
    string,
    {
      id: string;
      text: string;
      conversation: string;
      revision: string;
      delivered: boolean;
      notifying?: boolean;
      kind: 'question' | 'permission';
      queuedCount?: number;
      generation?: string;
      missingReads?: number;
      control?: ApprovalItem['nativeQuestion'];
    }
  >();
  const notifyObserved = (id: string) => {
    const entry = observed.get(id);
    if (!entry || entry.delivered || entry.notifying) return;
    const item = approvalInbox.getById(entry.id);
    if (!item) return;
    entry.notifying = true;
    // Do not let the outbound notification queue hold the session snapshot hostage.
    void Promise.resolve()
      .then(() => deps.questionObserved?.(item))
      .then((ok) => {
        if (observed.get(id) === entry) entry.delivered = ok !== false;
      })
      .catch(() => undefined)
      .finally(() => {
        entry.notifying = false;
      });
  };
  let caseRead: Promise<CaseInfo[]> | undefined;
  const healthReads = new WeakMap<Session, Promise<DiscordConnection>>();
  const captureReads = new WeakMap<Session, Promise<string | null | undefined>>();
  const health = (s: Session) =>
    observedRead(
      async () => {
        let run = healthReads.get(s);
        if (!run) {
          run = Promise.resolve()
            .then(() => deps.health!(s))
            .finally(() => {
              if (healthReads.get(s) === run) healthReads.delete(s);
            });
          healthReads.set(s, run);
        }
        return run;
      },
      { state: 'unverified', reason: 'check_failed' } as DiscordConnection
    );
  const reading = new Set<string>();
  const suggestion = async (s: Session) => {
    if (
      !['claude-tui', 'codex-tui'].includes(getCli(s.mode)?.capabilities.nativeSettingsProfile ?? '') ||
      reading.has(s.id) ||
      s.paneExit ||
      s.guardedInputHeld ||
      s.guardedInputPendingWrites ||
      approvalInbox
        .listPending()
        .some((p) => p.sessionId === s.id && p.kind !== 'idle' && p.id !== observed.get(s.id)?.id)
    )
      return undefined;
    reading.add(s.id);
    try {
      const generation = s.inspectionGeneration;
      const revision = s.discordQueueRevision,
        conversation = conversationFor(s);
      const frame = await observedRead(async () => {
        let run = captureReads.get(s);
        if (!run) {
          run = Promise.resolve()
            .then(() => deps.capture?.(s.id))
            .finally(() => {
              if (captureReads.get(s) === run) captureReads.delete(s);
            });
          captureReads.set(s, run);
        }
        return run;
      }, undefined);
      if (
        !deps.allowed() ||
        deps.sessions().get(s.id) !== s ||
        s.paneExit ||
        s.guardedInputHeld ||
        s.guardedInputPendingWrites ||
        generation !== s.inspectionGeneration ||
        revision !== s.discordQueueRevision ||
        conversation !== conversationFor(s) ||
        approvalInbox
          .listPending()
          .some((p) => p.sessionId === s.id && p.kind !== 'idle' && p.id !== observed.get(s.id)?.id)
      )
        return undefined;
      if (!frame) return undefined;
      if (getCli(s.mode)?.capabilities.nativeSettingsProfile === 'codex-tui') {
        let previous = observed.get(s.id);
        const retire = () => {
          if (previous && approvalInbox.getForSession(s.id)?.id === previous.id)
            approvalInbox.resolveForSession(s.id, 'superseded');
          observed.delete(s.id);
          previous = undefined;
        };
        if (previous && (previous.conversation !== conversation || previous.generation !== s.inspectionGeneration))
          retire();
        const count = codexQueuedQuestionCount(frame);
        if (count === undefined || !conversation) return undefined;
        if (!count) {
          if (previous && (previous.missingReads = (previous.missingReads ?? 0) + 1) >= 2) retire();
          return undefined;
        }
        if (previous) previous.missingReads = 0;
        if (!previous || previous.queuedCount !== count || !approvalInbox.getById(previous.id)) {
          const delivered = previous?.queuedCount === count && previous.delivered;
          const text = `Codex has ${count} queued ${count === 1 ? 'question' : 'questions'} for you. Work may continue. Open this session in Codeman and press Shift+← to review and answer. The collapsed indicator does not show the question text or choices.`;
          const item = approvalInbox.notePrompt({
            sessionId: s.id,
            sessionName: s.name || s.id.slice(0, 8),
            mode: s.mode,
            kind: 'question',
            toolName: 'QueuedQuestion',
            answerInTerminal: true,
            message: text,
            context: frame,
            cwd: s.workingDir,
          });
          previous = {
            id: item.id,
            text,
            conversation,
            revision,
            delivered: !!delivered,
            kind: 'question',
            queuedCount: count,
            generation: s.inspectionGeneration,
            missingReads: 0,
          };
          observed.set(s.id, previous);
        }
        notifyObserved(s.id);
        return undefined;
      }
      const dialog = parseClaudeVisibleQuestion(frame);
      const permission = dialog ? undefined : parseClaudeHookConfirmation(frame);
      const compaction = dialog || permission ? undefined : parseClaudeCompactionPrompt(frame);
      const text = dialog?.text ?? permission?.text ?? compaction?.text;
      const kind = permission ? 'permission' : 'question';
      const previous = observed.get(s.id);
      if (text && (dialog || permission || compaction) && conversation && revision !== undefined) {
        if (
          !previous ||
          previous.text !== text ||
          previous.kind !== kind ||
          (kind === 'permission' && previous.revision !== revision) ||
          previous.conversation !== conversation ||
          (previous.control &&
            (previous.control.state === 'answered' ||
              previous.revision !== revision ||
              previous.control.dialog.identity !== dialog?.identity))
        ) {
          const item = approvalInbox.notePrompt({
            sessionId: s.id,
            sessionName: s.name || s.id.slice(0, 8),
            mode: 'claude',
            kind,
            toolName: permission?.toolName ?? compaction?.toolName ?? 'AskUserQuestion',
            answerInTerminal: !dialog || dialog.multiSelect || typeof s.withNativeQuestionInput !== 'function',
            nativeQuestion:
              dialog && !dialog.multiSelect && typeof s.withNativeQuestionInput === 'function'
                ? { conversation, inputRevision: revision, dialog, state: 'pending' }
                : undefined,
            message:
              dialog && !dialog.multiSelect && typeof s.withNativeQuestionInput === 'function' ? dialog.question : text,
            context: frame,
            cwd: s.workingDir,
          });
          observed.set(s.id, {
            id: item.id,
            text,
            conversation,
            revision,
            delivered: false,
            kind,
            control: item.nativeQuestion,
          });
        }
        const current = observed.get(s.id)!;
        const item = approvalInbox.getById(current.id);
        if (
          dialog &&
          item?.nativeQuestion?.state === 'pending' &&
          item.nativeQuestion.dialog.identity === dialog.identity
        ) {
          item.nativeQuestion.dialog = dialog;
        }
        notifyObserved(s.id);
        return undefined;
      }
      if (
        previous &&
        (previous.conversation !== conversation || previous.revision !== revision || claudeQuestionGone(frame))
      ) {
        if (approvalInbox.getById(previous.id)) approvalInbox.resolveForSession(s.id, 'superseded');
        observed.delete(s.id);
      }
      return !working(s) && !approvalInbox.listPending().some((p) => p.sessionId === s.id && p.kind !== 'idle')
        ? claudePromptSuggestion(frame)
        : undefined;
    } catch {
      return undefined;
    } finally {
      reading.delete(s.id);
    }
  };
  return {
    enabled: () => deps.allowed(),
    connection: async (id, fresh) => {
      const s = session(id);
      return deps.health?.(s, fresh) ?? { state: s.paneExit ? 'agent_exited' : 'available' };
    },
    recover: async (id, conversation, current) => {
      const s = session(id);
      const valid = () =>
        deps.allowed() && current() && deps.sessions().get(id) === s && conversationFor(s) === conversation;
      if (!valid() || !deps.recover) return false;
      return deps.recover(s, valid);
    },
    sessions: async () => {
      if (!deps.allowed()) return [];
      for (const [id, old] of observed) {
        if (!deps.sessions().has(id)) {
          if (approvalInbox.getById(old.id)) approvalInbox.resolveForSession(id, 'expired');
          observed.delete(id);
        }
      }
      const cases = await observedRead(() => {
        if (!caseRead)
          caseRead = Promise.resolve()
            .then(() => deps.cases())
            .finally(() => {
              caseRead = undefined;
            });
        return caseRead;
      }, [] as CaseInfo[]);
      if (!deps.allowed()) return [];
      const visible = [...deps.sessions().values()].filter((s) => !s.suppressNotifications);
      const projected = await Promise.all(
        visible.map(async (s): Promise<DiscordUiSession> => {
          const connection = (deps.health ? await health(s) : undefined) ?? {
            state: s.paneExit ? ('agent_exited' as const) : ('available' as const),
          };
          const unavailable = connection.state !== 'available';
          const promptSuggestion = unavailable ? undefined : await suggestion(s);
          const modelObservation = deps.observed?.(s.id);
          const displayModel = s.displayModel;
          const pending = approvalInbox.listPending().find((p) => p.sessionId === s.id && p.kind !== 'idle');
          return {
            id: s.id,
            name: s.name || s.id.slice(0, 8),
            mode: s.mode,
            host: s.remote?.label || 'local',
            caseName:
              cases.find((c) =>
                s.remote
                  ? c.remote?.hostId === s.remote.hostId && c.remote.path === s.remote.remotePath
                  : !c.remote && c.path === s.workingDir
              )?.name || 'Unlinked workspace',
            connection,
            caseKey: resolveDiscordCase(
              { id: s.id, workingDir: s.workingDir, remote: s.remote, docker: s.docker, owner: s.owner },
              cases
            ).key,
            conversation: conversationFor(s),
            activityConversation: deps.activityConversation?.(s),
            inputRevision: s.discordQueueRevision,
            working: !unavailable && working(s),
            promptSuggestion,
            queuedQuestionCount: observed.get(s.id)?.id === pending?.id ? observed.get(s.id)?.queuedCount : undefined,
            lastPromptAt: s.lastRealPromptAt || undefined,
            pendingAt: pending?.createdAt,
            pendingRevision: pending ? discordApprovalRevision(pending) : undefined,
            pending: approvalInbox.listPending().some((p) => p.sessionId === s.id && p.kind !== 'idle'),
            exited: unavailable,
            ready: !unavailable && !working(s) && !s.paneExit && !s.guardedInputHeld && !s.guardedInputPendingWrites,
            model: modelObservation?.model
              ? modelObservation.model + ' (native verified)'
              : displayModel
                ? `${displayModel.model} (${displayModel.source})`
                : undefined,
            modelSource: modelObservation?.model ? 'native-verified' : displayModel?.source,
            effort: modelObservation?.effort ? modelObservation.effort + ' (native verified)' : undefined,
            approval:
              getCli(s.mode)?.launch.legacyConfigField === 'codexConfig'
                ? s.codexConfig?.baseCommand
                  ? 'Custom command authority'
                  : s.codexConfig?.dangerouslyBypassApprovals
                    ? 'Approve all (launch flag)'
                    : 'CLI default / ask'
                : 'CLI-controlled',
            url: deps.url() ? `${deps.url()!.replace(/\/$/, '')}/#session=${encodeURIComponent(s.id)}` : undefined,
          };
        })
      );
      return deps.allowed()
        ? projected.filter((row) =>
            visible.some((s) => s.id === row.id && deps.sessions().get(s.id) === s && !s.suppressNotifications)
          )
        : [];
    },
    caseChannels: async () => {
      if (!deps.allowed()) return [];
      const cases = await deps.cases();
      if (!deps.allowed()) return [];
      return cases.flatMap((c) => {
        const identity = configuredDiscordCaseChannel(c);
        return identity ? [identity] : [];
      });
    },
    cases: async () =>
      deps.allowed()
        ? (await deps.cases())
            .filter((c) => !c.docker && !c.unreachable)
            .flatMap((c) => {
              const key = configuredDiscordCaseKey(c);
              return key ? [{ key, name: c.name, host: c.remote?.hostId || 'local' }] : [];
            })
        : [],
    defaults: async () => {
      const s = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'Discord defaults', {});
      return {
        model: typeof s.codexModel === 'string' ? s.codexModel : '',
        effort: typeof s.codexReasoningEffort === 'string' ? s.codexReasoningEffort : '',
        approval: s.codexDangerouslyBypassApprovals === true ? 'approve-all' : 'ask',
      };
    },
    saveDefaults: async (v, current) => {
      if (!deps.allowed() || !current()) throw new Error('Settings context changed');
      if (!['approve-all', 'ask'].includes(v.approval)) throw new Error('Approval must be approve-all or ask');
      const parsed = SettingsUpdateSchema.parse({
        codexModel: v.model,
        codexReasoningEffort: v.effort,
        codexDangerouslyBypassApprovals: v.approval === 'approve-all',
      });
      await mutateSettingsFile((s) => {
        if (!deps.allowed() || !current()) throw new Error('Settings context changed');
        return { ...s, ...parsed };
      });
    },
    question: (id) => {
      if (!deps.allowed()) return undefined;
      const p = approvalInbox.listPending().find((p) => p.sessionId === id);
      if (!p || !approvalInbox.verifyStillAnswerable(p.id)) return undefined;
      return {
        id: p.id,
        revision: discordApprovalRevision(p),
        kind: p.kind,
        text: p.message || p.toolSummary || p.context || 'Reply to the current prompt',
        options: p.options ?? [],
        terminalOnly: !!p.answerInTerminal,
      };
    },
    answer: async (id, question, revision, value, current = () => true) => {
      const s = session(id),
        p = approvalInbox.getById(question);
      if (!p || p.sessionId !== id || discordApprovalRevision(p) !== revision)
        throw new Error('Question changed or was answered elsewhere');
      const answer =
        p.kind === 'idle'
          ? { action: 'text' as const, text: value }
          : value === 'deny'
            ? { action: 'deny' as const }
            : { action: 'option' as const, option: Number(value) };
      const result = await answerPendingApproval(
        s,
        question,
        answer,
        () => current() && deps.allowed() && deps.sessions().get(id) === s
      );
      if (!result.success) throw new Error('Native approval service refused the answer');
      return 'Answer sent to the exact pending prompt.';
    },
    workspaceHasChanges: async (id) => {
      const s = session(id);
      return discordWorkspaceHasChanges({ workingDir: s.workingDir, remote: s.remote });
    },
    workspace: async (id) => {
      const s = session(id);
      return discordWorkspaceResults({ workingDir: s.workingDir, remote: s.remote });
    },
    submitQueued: async (id, text, conversation, allowed, inputRevision) => {
      const s = session(id);
      if (deps.health && (await deps.health(s, true)).state !== 'available') return 'blocked';
      return s.submitDiscordFollowup(
        text,
        () =>
          deps.allowed() &&
          !working(s) &&
          inputRevision !== undefined &&
          s.discordQueueRevision === inputRevision &&
          allowed() &&
          deps.sessions().get(id) === s &&
          conversationFor(s) === conversation &&
          !approvalInbox.listPending().some((p) => p.sessionId === id && p.kind !== 'idle')
      );
    },
  };
}
