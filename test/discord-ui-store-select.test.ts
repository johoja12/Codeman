import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordUiStore } from '../src/discord-ui-store.js';

it('returns an isolated selection after queued edits without copying unrelated state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-select-'));
  try {
    const store = new DiscordUiStore(dir);
    const edit = store.edit((state) => {
      state.cards.one = { channel: '111111111111111111', hash: 'original', phase: 'ready', updated: Date.now() };
      state.cards.other = { channel: '222222222222222222', hash: 'private-other', phase: 'ready', updated: Date.now() };
    });
    const selected = await store.read((state) => state.cards.one);
    await edit;
    expect(selected.hash).toBe('original');
    expect(JSON.stringify(selected)).not.toContain('private-other');
    (selected as { hash: string }).hash = 'mutated';
    expect((await store.read((state) => state.cards.one)).hash).toBe('original');
    expect(await store.read((state) => state.cards.missing)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
