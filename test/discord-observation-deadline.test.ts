import { afterEach, expect, it, vi } from 'vitest';
import {
  createDiscordNativeUiServices,
  DISCORD_OBSERVATION_TIMEOUT_MS,
} from '../src/web/discord-native-ui-services.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import type { Session } from '../src/session.js';
const s = () =>
  ({
    id: 'deadline-test',
    name: 'test',
    mode: 'codex',
    nativeResumeId: 'native',
    inspectionGeneration: 'pane',
    discordQueueRevision: 'input',
    workingDir: '/tmp',
    isWorking: true,
  }) as unknown as Session;
const frame =
  'Working (1m • esc to interrupt)\n• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer\n› Ask Codex to do anything\n  GPT-6.2-Sol medium · /tmp\n  ← for agents · ? for shortcuts';
afterEach(() => {
  vi.useRealTimers();
  approvalInbox.resolveForSession('deadline-test', 'session_ended');
  approvalInbox.stop();
});
it('bounds and coalesces a stuck health read, then recovers when it settles', async () => {
  vi.useFakeTimers();
  const session = s();
  let release!: (value: { state: 'available' }) => void;
  const health = vi.fn(
    () =>
      new Promise<{ state: 'available' }>((resolve) => {
        release = resolve;
      })
  );
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[session.id, session]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    health,
  });
  for (let i = 0; i < 2; i++) {
    const p = services.sessions();
    await vi.advanceTimersByTimeAsync(DISCORD_OBSERVATION_TIMEOUT_MS + 1);
    expect((await p)[0].connection).toEqual({ state: 'unverified', reason: 'check_failed' });
  }
  expect(health).toHaveBeenCalledTimes(1);
  release({ state: 'available' });
  await vi.advanceTimersByTimeAsync(0);
  health.mockResolvedValue({ state: 'available' });
  expect((await services.sessions())[0].exited).toBe(false);
});
it('ignores late capture results and does not create a question after its deadline', async () => {
  vi.useFakeTimers();
  const session = s();
  let release!: (value: string) => void;
  const capture = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      })
  );
  const notify = vi.fn();
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[session.id, session]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture,
    questionObserved: notify,
  });
  const p = services.sessions();
  await vi.advanceTimersByTimeAsync(DISCORD_OBSERVATION_TIMEOUT_MS + 1);
  expect((await p)[0].pending).toBe(false);
  release(frame);
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).not.toHaveBeenCalled();
  expect(approvalInbox.getForSession(session.id)).toBeUndefined();
});
it('does not await or duplicate a pending question notification inside session observation', async () => {
  const session = s();
  const notify = vi.fn(() => new Promise<boolean>(() => {}));
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[session.id, session]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture: () => frame,
    questionObserved: notify,
  });
  expect((await services.sessions())[0].pending).toBe(true);
  await services.sessions();
  expect(notify).toHaveBeenCalledTimes(1);
});
it('does not publish a snapshot after authorization is revoked during a read', async () => {
  vi.useFakeTimers();
  const session = s();
  let allowed = true;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[session.id, session]]),
    cases: async () => [],
    allowed: () => allowed,
    url: () => undefined,
    health: () => new Promise(() => {}),
  });
  const p = services.sessions();
  await vi.advanceTimersByTimeAsync(0);
  allowed = false;
  await vi.advanceTimersByTimeAsync(DISCORD_OBSERVATION_TIMEOUT_MS + 1);
  expect(await p).toEqual([]);
});
