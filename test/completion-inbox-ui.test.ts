import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
const source = readFileSync(new URL('../src/web/public/completion-inbox-ui.js', import.meta.url), 'utf8');
function fixture() {
  const document = {
    visibilityState: 'visible',
    hasFocus: () => true,
    querySelectorAll: () => [] as unknown[],
    addEventListener: () => {},
  };
  const window: any = {};
  runInNewContext(source, { window, document, getComputedStyle: () => ({ visibility: 'visible' }), console });
  const app: any = {
    activeSessionId: 's1',
    terminalLoadStates: new Map(),
    terminal: { element: { getClientRects: () => [{}] }, buffer: { active: { viewportY: 0, baseY: 0 } } },
  };
  return { document, app, ui: window.CodemanCompletionInbox };
}
describe('completion read visibility proof', () => {
  it('requires a focused visible primary terminal at the bottom with no pending rendering or overlay', () => {
    const f = fixture();
    expect(f.ui.canAutoRead(f.app)).toBe(true);
    f.document.visibilityState = 'hidden';
    expect(f.ui.canAutoRead(f.app)).toBe(false);
    f.document.visibilityState = 'visible';
    f.document.hasFocus = () => false;
    expect(f.ui.canAutoRead(f.app)).toBe(false);
    f.document.hasFocus = () => true;
    f.app.terminal.buffer.active.viewportY = 1;
    expect(f.ui.canAutoRead(f.app)).toBe(false);
    f.app.terminal.buffer.active.viewportY = 0;
    f.app.terminalLoadStates.set('s1', {});
    expect(f.ui.canAutoRead(f.app)).toBe(false);
    f.app.terminalLoadStates.clear();
    f.app._terminalWriteInFlight = true;
    expect(f.ui.canAutoRead(f.app)).toBe(false);
    f.app._terminalWriteInFlight = false;
    f.app._tilesOwnTerminal = () => true;
    expect(f.ui.canAutoRead(f.app)).toBe(false);
    f.app._tilesOwnTerminal = () => false;
    f.document.querySelectorAll = () => [{ getClientRects: () => [{}], getAttribute: () => null }];
    expect(f.ui.canAutoRead(f.app)).toBe(false);
  });
  it('matches the actual visible answer across wraps and never acknowledges a generic short reply or unrelated output', () => {
    const { ui } = fixture();
    expect(
      ui.visibleResponseMatches(
        '**The reviewed build passed all native regression checks.**',
        'The reviewed build passed\nall native regression checks.'
      )
    ).toBe(true);
    expect(ui.visibleResponseMatches('Done', 'Done')).toBe(false);
    expect(
      ui.visibleResponseMatches(
        'The reviewed build passed all native regression checks.',
        'A completely different output'
      )
    ).toBe(false);
  });
});
