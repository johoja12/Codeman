import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDiscordNativeUiServices } from '../src/web/discord-native-ui-services.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';
import type { Session } from '../src/session.js';
beforeEach(async () => {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify({ theme: 'dark', codexDangerouslyBypassApprovals: true }));
});
describe('native Discord server services', () => {
  const services = (allowed = () => true) =>
    createDiscordNativeUiServices({
      sessions: () => new Map<string, Session>(),
      cases: async () => [],
      allowed,
      url: () => undefined,
    });
  it('validates and serializes future defaults while preserving other settings', async () => {
    const s = services();
    await s.saveDefaults({ model: 'gpt-6.1-sol', effort: 'high', approval: 'ask' }, () => true);
    expect(await s.defaults()).toEqual({ model: 'gpt-6.1-sol', effort: 'high', approval: 'ask' });
    expect(JSON.parse(await readFile(SETTINGS_PATH, 'utf8')).theme).toBe('dark');
  });
  it('rejects invalid values and revoked settings scope without a write', async () => {
    const original = await readFile(SETTINGS_PATH, 'utf8');
    await expect(
      services().saveDefaults({ model: 'bad;command', effort: 'high', approval: 'ask' }, () => true)
    ).rejects.toThrow();
    await expect(
      services().saveDefaults({ model: '', effort: 'unknown', approval: 'ask' }, () => true)
    ).rejects.toThrow();
    await expect(services().saveDefaults({ model: '', effort: '', approval: 'yes' }, () => true)).rejects.toThrow();
    await expect(services().saveDefaults({ model: '', effort: '', approval: 'ask' }, () => false)).rejects.toThrow(
      'context changed'
    );
    expect(await readFile(SETTINGS_PATH, 'utf8')).toBe(original);
  });
  it('disables the entire native UI surface without mapped single-user authorization', async () => {
    const s = services(() => false);
    expect(s.enabled()).toBe(false);
    expect(await s.sessions()).toEqual([]);
    expect(await s.cases()).toEqual([]);
    await expect(s.saveDefaults({ model: '', effort: '', approval: 'ask' }, () => true)).rejects.toThrow(
      'context changed'
    );
  });
});

it('projects background work as busy and captures only ready Claude suggestions', async () => {
  const s = {
    id: 's1',
    name: 'Claude',
    mode: 'claude',
    nativeResumeId: 'conversation',
    discordQueueRevision: 'revision',
    isWorking: false,
    watching: null,
    activityProjection: { activityStatus: 'idle' },
    workingDir: '/tmp',
  } as unknown as Session;
  let captures = 0;
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([['s1', s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture: () => {
      captures++;
      return '────────\n❯ \x1b[2mWrite regression tests\x1b[0m\n────────';
    },
  });
  expect((await services.sessions())[0]).toMatchObject({
    working: false,
    ready: true,
    promptSuggestion: 'Write regression tests',
  });
  Object.assign(s, { watching: '1 background task' });
  expect((await services.sessions())[0]).toMatchObject({ working: true, ready: false, promptSuggestion: undefined });
  Object.assign(s, { watching: null, activityProjection: { activityStatus: 'waiting_agents' } });
  expect((await services.sessions())[0]).toMatchObject({ working: true, ready: false, promptSuggestion: undefined });
  Object.assign(s, { mode: 'codex', activityProjection: { activityStatus: 'idle' } });
  expect((await services.sessions())[0].promptSuggestion).toBeUndefined();
  expect(captures).toBe(1);
});
