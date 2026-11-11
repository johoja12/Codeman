import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import { CreateSessionSchema, QuickStartSchema } from '../src/web/schemas.js';
import { createRecoveryRecord } from '../src/session-recovery.js';
import { recoverySessionConfig } from '../src/web/session-recovery-service.js';
import { createRouteTestHarness } from './routes/_route-test-utils.js';
import { registerSessionRoutes } from '../src/web/routes/session-routes.js';
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it('validates notification suppression as an optional boolean on both create routes', () => {
  for (const schema of [CreateSessionSchema, QuickStartSchema]) {
    expect(schema.parse({ suppressNotifications: true }).suppressNotifications).toBe(true);
    expect(schema.parse({}).suppressNotifications).toBeUndefined();
    for (const value of [null, 'true', 1])
      expect(schema.safeParse({ suppressNotifications: value }).success).toBe(false);
  }
});
it('round trips suppression through session state and manual recovery without changing the default', () => {
  const s = new Session({ workingDir: '/tmp', mode: 'shell', suppressNotifications: true });
  expect(s.toLightDetailedState().suppressNotifications).toBe(true);
  const restored = new Session({ workingDir: '/tmp', mode: 'shell', ...s.toState() });
  expect(restored.suppressNotifications).toBe(true);
  const record = createRecoveryRecord(s.toState());
  expect(record.suppressNotifications).toBe(true);
  const config = recoverySessionConfig(record, 'resume', {});
  expect(config.suppressNotifications).toBe(true);
  const normal = new Session({ workingDir: '/tmp', mode: 'shell' });
  expect(normal.suppressNotifications).toBe(false);
  expect(normal.toState()).not.toHaveProperty('suppressNotifications');
});
it.each([true, false, undefined])(
  'POST /api/sessions applies suppression=%s before adding/broadcasting the session',
  async (value) => {
    const dir = await mkdtemp(join(tmpdir(), 'codeman-suppressed-'));
    dirs.push(dir);
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    const { app, ctx } = await createRouteTestHarness(registerSessionRoutes);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { mode: 'shell', workingDir: dir, suppressNotifications: value },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const created = body.data?.session ?? body.session;
      expect(created.suppressNotifications === true).toBe(value === true);
      const added = ctx.addSession.mock.calls.at(-1)![0] as unknown as Session;
      expect(added.suppressNotifications).toBe(value === true);
    } finally {
      await app.close();
    }
  }
);
it.each(['suppressed', 'adopted'])(
  'prevents server notifications and Discord automation for a %s session',
  async (kind) => {
    const server = new WebServer(0, false, true) as any;
    const silent = new Session({
      workingDir: '/tmp',
      mode: 'shell',
      suppressNotifications: kind === 'suppressed',
      adopt:
        kind === 'adopted' ? { location: 'local', socketPath: '/tmp/test-default', targetSession: 'human' } : undefined,
    });
    const normal = new Session({ workingDir: '/tmp', mode: 'shell' });
    server.sessions.set(silent.id, silent);
    server.sessions.set(normal.id, normal);
    const webhook = vi.spyOn(server.webhookNotifier, 'notify').mockResolvedValue(undefined);
    const discord = vi.spyOn(server.discordBridge, 'notify').mockResolvedValue({ ok: true, at: 1 });
    const subscriptions = vi.spyOn(server.pushStore, 'getAll').mockReturnValue([]);
    const created = vi.spyOn(server.discordBridge, 'sessionCreated').mockResolvedValue(undefined);
    const renamed = vi.spyOn(server.discordBridge, 'sessionRenamed').mockResolvedValue(undefined);
    for (const event of [
      'hook:permission_prompt',
      'hook:elicitation_dialog',
      'hook:idle_prompt',
      'hook:stop',
      'session:error',
      'respawn:blocked',
    ]) {
      await server.sendPushNotifications(event, { sessionId: silent.id });
    }
    server.bridgeSessionEvent('session:created', { id: silent.id });
    server.bridgeSessionEvent('session:updated', { session: silent.toState() });
    expect(webhook).not.toHaveBeenCalled();
    expect(discord).not.toHaveBeenCalled();
    expect(subscriptions).not.toHaveBeenCalled();
    expect(created).not.toHaveBeenCalled();
    expect(renamed).not.toHaveBeenCalled();
    expect(server.discordBridge.deps.sessions().map((s: { id: string }) => s.id)).toEqual([normal.id]);
    await server.sendPushNotifications('hook:stop', { sessionId: normal.id });
    expect(webhook).toHaveBeenCalledOnce();
    expect(discord).toHaveBeenCalledOnce();
    expect(subscriptions).toHaveBeenCalledOnce();
  }
);
