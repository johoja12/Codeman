import { mkdtemp, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { CompletionInbox } from '../src/completion-inbox.js';
import type { DiscordHistory } from '../src/discord-history.js';
const history = (state: 'running' | 'completed', n = 1): DiscordHistory => ({
  conversationId: 'convo',
  partial: false,
  turns: [
    { cursor: 'user:' + n, role: 'user', text: 'Build', timestamp: '' },
    { cursor: 'answer:' + n, role: 'assistant', phase: 'final_answer', text: 'Visible response', timestamp: '' },
  ],
  executions: [{ userCursor: 'user:' + n, state, promptHash: 'a'.repeat(64) }],
});
const input = (h: DiscordHistory) => ({
  session: 's1',
  name: 'Build',
  guild: '111111111111111111',
  channel: '222222222222222222',
  history: h,
});
describe('shared native completion inbox', () => {
  it('baselines old completions, records native finishes once, and persists exact acknowledgement across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'completion-'));
    try {
      let now = 1000;
      let store = new CompletionInbox(dir, () => now);
      expect(await store.observe(input(history('completed')))).toBe(false);
      expect(await store.list()).toEqual([]);
      const next = history('running', 2);
      await store.observe(input(next));
      now = 2000;
      expect(await store.observe(input(history('completed', 2)))).toBe(true);
      const [entry] = await store.list();
      expect(entry.userCursor).toBe('user:2');
      expect(entry.responseCursor).toBe('answer:2');
      await store.observe(input(history('completed', 2)));
      expect(await store.list()).toHaveLength(1);
      await store.review([entry.id], 'web');
      store = new CompletionInbox(dir, () => 3000);
      expect((await store.list())[0]).toMatchObject({ reviewed: 2000, source: 'web' });
      await store.observe(input(history('completed', 2)));
      expect(await store.list()).toHaveLength(1);
      expect((await stat(join(dir, 'completion-inbox.json'))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('does not acknowledge a newer finish through an older entry, and never treats idle or failed work as completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'completion-'));
    try {
      let now = 1000;
      const store = new CompletionInbox(dir, () => now);
      await store.observe(input(history('running')));
      await store.observe(input(history('completed')));
      const first = (await store.list())[0];
      await store.observe(input(history('running', 2)));
      now = 2000;
      await store.observe(input(history('completed', 2)));
      await store.review([first.id], 'discord');
      const entries = await store.list();
      expect(entries.find((e) => e.id === first.id)?.reviewed).toBe(2000);
      expect(entries.find((e) => e.id !== first.id)?.reviewed).toBeUndefined();
      await store.observe(
        input({
          ...history('running', 3),
          executions: [{ userCursor: 'user:3', promptHash: 'proof', state: 'execution_error' }],
        })
      );
      expect(await store.list()).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses symlinked or corrupt state rather than forgetting read/deduplication history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'completion-'));
    try {
      const target = join(dir, 'target');
      await writeFile(target, '{}');
      await symlink(target, join(dir, 'completion-inbox.json'));
      await expect(new CompletionInbox(dir).list()).rejects.toThrow('unavailable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
