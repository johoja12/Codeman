import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexQueuedQuestionCount } from '../src/web/codex-queued-question.js';
import { createDiscordNativeUiServices } from '../src/web/discord-native-ui-services.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import type { Session } from '../src/session.js';
const footer =
  '\n› Ask Codex to do anything\n  GPT-6.2-Sol medium · /workspace · Task\n  ← for agents · ? for shortcuts';
const indicator = '• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer';
const frame =
  'Working (1h 03m • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close\n\n' +
  indicator +
  '\n\n' +
  footer;
afterEach(() => {
  approvalInbox.resolveForSession('queued-test', 'session_ended');
  approvalInbox.stop();
});
describe('queued Codex question chrome', () => {
  it('recognizes current screen, ANSI and multiple questions', () => {
    expect(codexQueuedQuestionCount(frame)).toBe(1);
    expect(codexQueuedQuestionCount('\x1b[34m' + frame + '\x1b[0m')).toBe(1);
    expect(codexQueuedQuestionCount(frame.replace('1 question', '3 questions'))).toBe(3);
  });
  it.each([
    '',
    indicator,
    frame.replace('shift+← to answer', 'press enter to submit'),
    frame.replace('1 question', '0 questions'),
    frame.replace('1 question', '1 questions'),
    frame.replace('← for agents · ? for shortcuts', 'unrecognized footer'),
    frame.replace('• Queued follow-up inputs', 'Quoted queued follow-up inputs'),
    frame + '\nnew text',
    'x'.repeat(128 * 1024) + frame,
  ])('does not infer a pending question from incomplete/unrecognized input', (raw) => {
    expect([undefined, 0]).toContain(codexQueuedQuestionCount(raw));
  });
  it('rejects a quoted indicator before real working chrome and normal queued prompts', () => {
    expect(codexQueuedQuestionCount(indicator + '\nWorking (1m • esc to interrupt)' + footer)).toBe(0);
    expect([undefined, 0]).toContain(codexQueuedQuestionCount('• Queued follow-up inputs\n  Run the tests' + footer));
    expect(codexQueuedQuestionCount(footer)).toBe(0);
  });
});
function fixture() {
  const session = {
    id: 'queued-test',
    name: 'w30-buildmesh',
    mode: 'codex',
    nativeResumeId: 'exact-native',
    inspectionGeneration: 'pane-1',
    discordQueueRevision: 'input-1',
    isWorking: true,
    workingDir: '/workspace',
    activityProjection: { activityStatus: 'busy' },
    watching: '1 background terminal',
  } as unknown as Session;
  const map = new Map([['queued-test', session]]);
  let screen: string | null = frame;
  const delivered = vi.fn(async () => true);
  let allowed = true;
  const services = createDiscordNativeUiServices({
    sessions: () => map,
    cases: async () => [],
    allowed: () => allowed,
    url: () => undefined,
    capture: () => screen,
    questionObserved: delivered,
  });
  return {
    session,
    map,
    services,
    delivered,
    setScreen: (s: string | null) => {
      screen = s;
    },
    disable: () => {
      allowed = false;
    },
  };
}
describe('queued questions in Discord services', () => {
  it('alerts once while work continues and exposes a terminal-only question', async () => {
    const f = fixture();
    expect((await f.services.sessions())[0]).toMatchObject({
      working: true,
      pending: true,
      exited: false,
      ready: false,
      queuedQuestionCount: 1,
    });
    expect(f.services.question(f.session.id)).toMatchObject({ kind: 'question', terminalOnly: true, options: [] });
    expect(f.services.question(f.session.id)?.text).toContain('Shift+←');
    await f.services.sessions();
    Object.assign(f.session, { discordQueueRevision: 'resized-or-typed' });
    await f.services.sessions();
    expect(f.delivered).toHaveBeenCalledTimes(1);
    const q = f.services.question(f.session.id)!;
    await expect(f.services.answer(f.session.id, q.id, q.revision, '1')).rejects.toThrow();
  });
  it('retries failed delivery and does not duplicate successful delivery', async () => {
    const f = fixture();
    f.delivered.mockResolvedValueOnce(false);
    await f.services.sessions();
    await f.services.sessions();
    await f.services.sessions();
    expect(f.delivered).toHaveBeenCalledTimes(2);
  });
  it('updates a changed count and clears only after two complete absent frames', async () => {
    const f = fixture();
    await f.services.sessions();
    f.setScreen(frame.replace('1 question', '2 questions'));
    expect((await f.services.sessions())[0].queuedQuestionCount).toBe(2);
    expect(f.delivered).toHaveBeenCalledTimes(2);
    f.setScreen(null);
    await f.services.sessions();
    expect(f.services.question(f.session.id)).toBeDefined();
    f.setScreen(footer);
    await f.services.sessions();
    expect(f.services.question(f.session.id)).toBeDefined();
    expect((await f.services.sessions())[0].pending).toBe(false);
    expect(f.services.question(f.session.id)).toBeUndefined();
    f.setScreen(frame);
    await f.services.sessions();
    expect(f.delivered).toHaveBeenCalledTimes(3);
  });
  it('does not overwrite another pending permission or leak a suppressed session', async () => {
    const f = fixture();
    approvalInbox.notePrompt({ sessionId: f.session.id, kind: 'permission', message: 'Another dialog' });
    await f.services.sessions();
    expect(f.delivered).not.toHaveBeenCalled();
    expect(approvalInbox.getForSession(f.session.id)?.message).toBe('Another dialog');
    Object.assign(f.session, { suppressNotifications: true });
    expect(await f.services.sessions()).toEqual([]);
  });
  it('restores the pending question after an expanded dialog resolves, without another notification', async () => {
    const f = fixture();
    await f.services.sessions();
    approvalInbox.notePrompt({
      sessionId: f.session.id,
      kind: 'permission',
      message: 'Expanded dialog',
      answerInTerminal: true,
    });
    await f.services.sessions();
    expect(f.delivered).toHaveBeenCalledTimes(1);
    approvalInbox.resolveForSession(f.session.id, 'resolved_in_terminal');
    expect((await f.services.sessions())[0].queuedQuestionCount).toBe(1);
    expect(f.services.question(f.session.id)?.terminalOnly).toBe(true);
    expect(f.delivered).toHaveBeenCalledTimes(1);
  });
  it('does not observe without native identity or authorization', async () => {
    const f = fixture();
    Object.assign(f.session, { nativeResumeId: null });
    await f.services.sessions();
    expect(f.delivered).not.toHaveBeenCalled();
    f.disable();
    expect(await f.services.sessions()).toEqual([]);
  });
  it('clears a resolved question when only ordinary queued follow-up text remains', async () => {
    const f = fixture();
    await f.services.sessions();
    f.setScreen('• Queued follow-up inputs\n  Run the tests' + footer);
    await f.services.sessions();
    await f.services.sessions();
    expect(f.services.question(f.session.id)).toBeUndefined();
  });
  it.each(['conversation', 'pane', 'input', 'authorization'])(
    'rejects a capture racing %s replacement',
    async (change) => {
      const f = fixture();
      const notified = vi.fn();
      const service = createDiscordNativeUiServices({
        sessions: () => f.map,
        cases: async () => [],
        allowed: () => f.map.has('queued-test'),
        url: () => undefined,
        capture: () => {
          if (change === 'conversation') Object.assign(f.session, { nativeResumeId: 'different' });
          if (change === 'pane') Object.assign(f.session, { inspectionGeneration: 'different' });
          if (change === 'input') Object.assign(f.session, { discordQueueRevision: 'different' });
          if (change === 'authorization') f.map.clear();
          return frame;
        },
        questionObserved: notified,
      });
      await service.sessions();
      expect(notified).not.toHaveBeenCalled();
    }
  );
  it('retires observations on conversation/pane replacement and session removal', async () => {
    const f = fixture();
    await f.services.sessions();
    Object.assign(f.session, { nativeResumeId: 'replacement', inspectionGeneration: 'pane-2' });
    f.setScreen(footer);
    await f.services.sessions();
    expect(f.services.question(f.session.id)).toBeUndefined();
    f.setScreen(frame);
    await f.services.sessions();
    f.map.clear();
    await f.services.sessions();
    expect(f.services.question(f.session.id)).toBeUndefined();
  });
});
