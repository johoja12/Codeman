import { afterEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../src/config/cli-registry/registry.js';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { readNativeModelMenu } from '../src/discord-model-controls.js';
import { nativeModelComposerReady } from '../src/native-composer-ready.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
afterEach(() => vi.restoreAllMocks());
describe('registry-selected native settings protocols', () => {
  it('uses an explicit protocol for a custom CLI ID rather than guessing from its name', () => {
    const original = registry.getCli;
    const stock = original('codex')!;
    const alias = { ...stock, id: 'custom-native' } as CliEntry;
    vi.spyOn(registry, 'getCli').mockImplementation((id) => (id === 'custom-native' ? alias : original(id)));
    const screen = '› \n\n  GPT-6.1-Sol · /tmp\n  ? for shortcuts';
    expect(nativeModelComposerReady('custom-native', screen)).toBe(true);
    const menu = 'Select Model and Effort\n› 1. GPT-6.1-Sol (current)\n  2. GPT-6-Astra\nenter select · esc back';
    expect(readNativeModelMenu('custom-native', menu)).toEqual(readNativeModelMenu('codex', menu));
  });
  it('fails closed when the entry does not declare a verified native protocol', () => {
    const original = registry.getCli;
    const entry = original('codex')!;
    const disabled = { ...entry, capabilities: { ...entry.capabilities, nativeSettingsProfile: undefined } };
    vi.spyOn(registry, 'getCli').mockImplementation((id) => (id === 'codex' ? disabled : original(id)));
    expect(nativeModelComposerReady('codex', '› \n  GPT-6.1-Sol · /tmp')).toBe(false);
    expect(readNativeModelMenu('codex', 'Select Model and Effort')).toBeUndefined();
  });
  it('accepts the known native protocol and rejects unknown profile names at registry load', () => {
    const entry = registry.getCli('codex')!;
    expect(CliEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      CliEntrySchema.safeParse({
        ...entry,
        capabilities: { ...entry.capabilities, nativeSettingsProfile: 'unverified-tui' },
      }).success
    ).toBe(false);
  });
});
