import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const terminalUi = fs.readFileSync(path.resolve('src/web/public/terminal-ui.js'), 'utf8');
const stylesCss = fs.readFileSync(path.resolve('src/web/public/styles.css'), 'utf8');
const mobileCss = fs.readFileSync(path.resolve('src/web/public/mobile.css'), 'utf8');
const handlers = fs.readFileSync(path.resolve('src/web/public/mobile-handlers.js'), 'utf8');

describe('opencode scroll perf', () => {
  it('uses the upstream forward/page/local route for touch and momentum', () => {
    expect(terminalUi).toContain('this._shouldForwardWheelToApp({ shiftKey: false })');
    expect(terminalUi).toContain('this._maybePageCliTranscript({ shiftKey: false, touchId: touchContactId }, lines)');
    expect(terminalUi).toContain("container.style.touchAction = 'none';");
    expect(terminalUi).not.toContain('_sendForegroundTuiWheel');
  });

  it('fixes will-change: contain layout and auto, scrolling stays auto (COD-284)', () => {
    expect(stylesCss).toContain('contain: layout paint;');
    expect(stylesCss).toContain('will-change: auto;');
    expect(stylesCss).toMatch(/\.touch-device\s+\.terminal-container\.scrolling[^}]*will-change:\s*auto/s);
    expect(stylesCss).not.toMatch(/\.touch-device\s+\.terminal-container\.scrolling[^}]*will-change:\s*transform/s);
    const termBlock = stylesCss.match(/\.terminal-container\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(termBlock).toContain('contain: layout paint;');
    expect(termBlock).not.toContain('will-change: contents');
    expect(termBlock).toContain('will-change: auto;');
    // COD-284: canvas strict containment sliced backing store on iOS keyboard resize
    expect(stylesCss).toMatch(/\.terminal-container\s+canvas\s*\{[^}]*contain:\s*paint/s);
    expect(stylesCss).not.toMatch(/\.terminal-container\s+canvas\s*\{[^}]*contain:\s*strict/s);
  });

  it('mobile.css terminal touch-action allows pan-y path', () => {
    expect(mobileCss).toContain('pan-y');
  });

  it('MobileDetection exposes isMobile for opencode branching', () => {
    expect(handlers).toMatch(/isMobile\(\)/);
  });
});
