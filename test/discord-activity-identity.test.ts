import { describe, expect, it } from 'vitest';
import { DiscordActivityIdentities } from '../src/discord-activity-identity.js';
import type { Session } from '../src/session.js';

const fixture = () => {
  const env: Record<string, string> = {};
  const session = {
    mode: 'codex',
    workingDir: '/workspace',
    nativeResumeId: 'configured-old',
    claudeSessionId: 'configured-old',
    codexConfig: { resumeSessionId: 'configured-old' },
    discordQueueRevision: 'input-one',
    envOverrideValue: (key: string) => env[key],
  } as unknown as Session;
  const identities = new DiscordActivityIdentities();
  return { session, env, identities };
};
describe('display-only canonical activity identity', () => {
  it('requires fresh evidence and never rewrites input/resume authority', () => {
    const { session, identities } = fixture();
    expect(identities.get(session)).toBeUndefined();
    identities.remember(session, identities.scope(session), 'verified-current');
    expect(identities.get(session)).toBe('verified-current');
    expect(session.nativeResumeId).toBe('configured-old');
    expect(session.codexConfig?.resumeSessionId).toBe('configured-old');
    expect(new DiscordActivityIdentities().get(session)).toBeUndefined();
    expect(identities.get({ ...session } as Session)).toBeUndefined();
  });
  it.each(['input', 'mode', 'native', 'claude', 'configured', 'cwd', 'home', 'claudeHome', 'remote', 'container'])(
    'invalidates evidence after %s changes',
    (change) => {
      const { session, env, identities } = fixture();
      const scope = identities.scope(session);
      identities.remember(session, scope, 'verified-current');
      if (change === 'input') Object.assign(session, { discordQueueRevision: 'new-input' });
      if (change === 'mode') Object.assign(session, { mode: 'claude' });
      if (change === 'native') Object.assign(session, { nativeResumeId: 'new-native' });
      if (change === 'claude') Object.assign(session, { claudeSessionId: 'new-claude' });
      if (change === 'configured') Object.assign(session, { codexConfig: { resumeSessionId: 'new-configured' } });
      if (change === 'cwd') Object.assign(session, { workingDir: '/other' });
      if (change === 'home') env.CODEX_HOME = '/other/home';
      if (change === 'claudeHome') env.CLAUDE_CONFIG_DIR = '/other/config';
      if (change === 'remote')
        Object.assign(session, {
          remote: { hostId: 'other', host: 'host', port: 22, username: 'u', remotePath: '/workspace', owned: true },
        });
      if (change === 'container') Object.assign(session, { docker: {} });
      expect(identities.get(session)).toBeUndefined();
      identities.remember(session, scope, 'late-result');
      expect(identities.get(session)).toBeUndefined();
    }
  );
  it('forgets a failed canonical read without creating or modifying a native session', () => {
    const { session, identities } = fixture();
    identities.remember(session, identities.scope(session), 'verified-current');
    identities.forget(session);
    expect(identities.get(session)).toBeUndefined();
    expect(session.nativeResumeId).toBe('configured-old');
  });
});

it.each(['profile', 'command', 'modelRevision', 'submit'])(
  'drops evidence when canonical history scope %s changes',
  (change) => {
    const { session, identities } = fixture();
    Object.assign(session, {
      remote: { hostId: 'h', host: 'h', port: 22, username: 'u', remotePath: '/w', owned: true },
    });
    const scope = identities.scope(session);
    identities.remember(session, scope, 'verified-current');
    if (change === 'profile') Object.assign(session.remote!, { codexCommandProfileId: 'different' });
    if (change === 'command') Object.assign(session.remote!, { commands: { codex: 'different' } });
    if (change === 'modelRevision') Object.assign(session, { nativeModelSettingsRevision: 'different' });
    if (change === 'submit') Object.assign(session, { lastSubmitAt: 42 });
    expect(identities.get(session)).toBeUndefined();
    identities.remember(session, scope, 'late-result');
    expect(identities.get(session)).toBeUndefined();
  }
);
