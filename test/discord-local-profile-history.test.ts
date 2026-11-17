import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, it, expect, vi } from 'vitest';
import { readDiscordSessionHistory } from '../src/discord-history.js';
import * as local from '../src/discord-local-conversation.js';
import type { Session } from '../src/session.js';
const id = '01a1e924-0aa3-73b2-91fc-f2f607f28e91',
  sid = '6ebc3cce-33ca-40d7-80cf-1b07763ea340';
let home: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (home) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  home = await mkdtemp(join(tmpdir(), 'codeman-local-profile-'));
  await mkdir(join(home, 'sessions'));
  await writeFile(
    join(home, 'sessions', 'rollout-' + id + '.jsonl'),
    [
      { type: 'session_meta', payload: { id, originator: 'codeman_' + sid, cwd: '/work/brain' } },
      {
        type: 'turn_context',
        timestamp: '2026-11-17T10:00:00Z',
        payload: { model: 'gpt-6.1-terra', effort: 'medium' },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n'
  );
  const runtime = { configHome: home, fingerprint: 'a'.repeat(64) };
  vi.spyOn(local, 'probeLocalDiscordRuntime').mockResolvedValue(runtime);
  const s = {
    id: sid,
    muxName: 'codeman-' + sid.slice(0, 8),
    mode: 'codex',
    workingDir: '/work/brain',
    nativeResumeId: null as string | null,
    envOverrideValue: (_key: string): string | undefined => undefined,
    setNativeResumeId: vi.fn((value: string) => {
      s.nativeResumeId = value;
    }),
  };
  return { s, runtime, run: () => readDiscordSessionHistory(s as unknown as Session) };
}
it('reads and binds only the owned rollout in the exact local process profile', async () => {
  const f = await fixture();
  const h = await f.run();
  expect(h.conversationId).toBe(id);
  expect(h.reportedSettings?.model).toBe('gpt-6.1-terra');
  expect(f.s.setNativeResumeId).toHaveBeenCalledWith(id);
});
it('refuses a process changing during history reads without adopting a conversation', async () => {
  const f = await fixture();
  vi.mocked(local.probeLocalDiscordRuntime)
    .mockReset()
    .mockResolvedValueOnce(f.runtime)
    .mockResolvedValue({ ...f.runtime, fingerprint: 'b'.repeat(64) });
  await expect(f.run()).rejects.toThrow('profile');
  expect(f.s.setNativeResumeId).not.toHaveBeenCalled();
});
it('does not replace a pinned conversation with a newer owned rollout', async () => {
  const f = await fixture();
  f.s.nativeResumeId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await expect(f.run()).rejects.toThrow();
  expect(f.s.setNativeResumeId).not.toHaveBeenCalled();
});
it('fails closed when the attached runtime cannot be verified', async () => {
  const f = await fixture();
  vi.mocked(local.probeLocalDiscordRuntime).mockResolvedValue(undefined);
  await expect(f.run()).rejects.toThrow('profile');
  expect(f.s.setNativeResumeId).not.toHaveBeenCalled();
});
it('refuses a configured profile conflicting with the running process', async () => {
  const f = await fixture();
  f.s.envOverrideValue = () => '/different/profile';
  await expect(f.run()).rejects.toThrow('profile');
  expect(f.s.setNativeResumeId).not.toHaveBeenCalled();
});
