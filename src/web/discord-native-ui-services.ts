/** Server adapters for native Discord UI. Reuses settings, approval and file/SSH guards. */
import { approvalInbox } from './approval-inbox.js';
import { answerPendingApproval } from './routes/approval-routes.js';
import { discordApprovalRevision } from '../discord-task-controls.js';
import { readJsonConfig, SETTINGS_PATH } from './route-helpers.js';
import { SettingsUpdateSchema } from './schemas.js';
import { mutateSettingsFile } from './settings-writer.js';
import { discordWorkspaceResults } from '../discord-workspace-results.js';
import { configuredDiscordCaseKey } from '../discord-case-identity.js';
import type { DiscordNativeUiServices } from '../discord-native-ui-types.js';
import type { Session } from '../session.js';
import type { CaseInfo } from '../types.js';
interface Deps {
  sessions(): Map<string, Session>;
  cases(): Promise<CaseInfo[]>;
  allowed(): boolean;
  url(): string | undefined;
  observed?(id: string): { model: string; effort?: string } | undefined;
}
export function createDiscordNativeUiServices(deps: Deps): DiscordNativeUiServices {
  const session = (id: string) => {
    const s = deps.sessions().get(id);
    if (!deps.allowed() || !s) throw new Error('Session unavailable');
    return s;
  };
  return {
    enabled: () => deps.allowed(),
    sessions: async () => {
      if (!deps.allowed()) return [];
      const cases = await deps.cases();
      return [...deps.sessions().values()].map((s) => ({
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
        conversation: s.nativeResumeId ?? s.codexConfig?.resumeSessionId,
        inputRevision: s.discordQueueRevision,
        working: s.isWorking,
        pending: approvalInbox.listPending().some((p) => p.sessionId === s.id && p.kind !== 'idle'),
        exited: !!s.paneExit,
        ready: !s.isWorking && !s.paneExit && !s.guardedInputHeld && !s.guardedInputPendingWrites,
        model: deps.observed?.(s.id)?.model
          ? deps.observed(s.id)!.model + ' (native verified)'
          : s.displayModel
            ? `${s.displayModel.model} (${s.displayModel.source})`
            : undefined,
        effort: deps.observed?.(s.id)?.effort, // launch effort is not proof of a current setting
        approval:
          s.mode === 'codex'
            ? s.codexConfig?.baseCommand
              ? 'Custom command authority'
              : s.codexConfig?.dangerouslyBypassApprovals
                ? 'Approve all (launch flag)'
                : 'CLI default / ask'
            : 'CLI-controlled',
        url: deps.url() ? `${deps.url()!.replace(/\/$/, '')}/#session=${encodeURIComponent(s.id)}` : undefined,
      }));
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
    answer: async (id, question, revision, value) => {
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
      const result = await answerPendingApproval(s, question, answer);
      if (!result.success) throw new Error('Native approval service refused the answer');
      return 'Answer sent to the exact pending prompt.';
    },
    workspace: async (id) => {
      const s = session(id);
      return discordWorkspaceResults({ workingDir: s.workingDir, remote: s.remote });
    },
    submitQueued: async (id, text, conversation, allowed, inputRevision) => {
      const s = session(id);
      return s.submitDiscordFollowup(
        text,
        () =>
          deps.allowed() &&
          inputRevision !== undefined &&
          s.discordQueueRevision === inputRevision &&
          allowed() &&
          deps.sessions().get(id) === s &&
          (s.nativeResumeId ?? s.codexConfig?.resumeSessionId) === conversation &&
          !approvalInbox.listPending().some((p) => p.sessionId === id && p.kind !== 'idle')
      );
    },
  };
}
