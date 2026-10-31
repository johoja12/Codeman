/** Real browser DOM/focus regression; uses exact methods, no live sessions or native keyboard claims. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
function method(file: string, name: string): string {
  const source = readFileSync(resolve(publicDir, file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let result = '';
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === name) result = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}
const methods = ['handleSessionTabClick', '_shouldFocusTerminalForTabSwitch', 'selectSession']
  .map((name) => method('app.js', name))
  .join(',');
async function harness(browser: Browser, touch = true): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: touch ? 393 : 1280, height: 852 },
    hasTouch: touch,
    isMobile: touch,
  });
  await page.setContent(
    '<button id="same">Same tab</button><button id="other">Other tab</button><textarea id="terminal"></textarea>'
  );
  await page.addScriptTag({
    content: `
    window.KeyboardHandler={keyboardVisible:false};window.MobileDetection={isTouchDevice:()=>${touch}};
    window._crashDiag={log(){}};window.focusCalls=0;
    window.app={${methods},activeSessionId:'a',isSoloWindow:true,detachedSessions:new Set(),
      sessions:new Map([['b',{name:'b'}]]),_selectGeneration:0,
      terminal:{options:{},focus(){focusCalls++;document.getElementById('terminal').focus()}},
      _clearTimer(){},_flushLocalEchoTo(){},_setTerminalLoadState(){},_cleanupPreviousSession(){},_userScrollback(){return 100000},_renderHistoryTruncationBanner(){},_updateSseSubscription(){},_queueTransportActivationReconcile(){},_connectWs(){},hideWelcome(){},playTerminalEntrance(){throw Error('STOP_BEFORE_SESSION_IO')},markIdleAlertSeen(){}};
    const select=app.selectSession;app.selectSession=(...args)=>select.apply(app,args).catch(e=>{
      if(e.message!=='STOP_BEFORE_SESSION_IO')throw e;
    });
    document.getElementById('same').onclick=e=>app.handleSessionTabClick(e,'a');
    document.getElementById('other').onclick=e=>app.handleSessionTabClick(e,'b');
  `,
  });
  return page;
}
describe('explicit mobile tab keyboard focus', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  for (const target of ['same', 'other']) {
    it(`focuses the terminal synchronously for a closed-keyboard ${target} tab tap`, async () => {
      const page = await harness(browser);
      try {
        await page.locator('#terminal').focus(); // stale textarea focus with keyboard gone
        await page.locator(`#${target}`).tap();
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
        expect(await page.evaluate('focusCalls')).toBe(1);
      } finally {
        await page.close();
      }
    });
  }
  it('direct same-session selection also restores terminal focus', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate('app.selectSession("a")');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('keeps keyboard-hidden automatic selection passive, and preserves an existing keyboard', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate('app.selectSession("b",{auto:true})');
      expect(await page.evaluate('focusCalls')).toBe(0);
      await page.evaluate(
        'KeyboardHandler.keyboardVisible=true;app.activeSessionId="a";app.selectSession("b",{auto:true})'
      );
      expect(await page.evaluate('focusCalls')).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('reveals a webview-hidden terminal before spending the synchronous focus', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate(() => {
        const input = document.getElementById('terminal')!;
        const wrap = document.createElement('div');
        wrap.id = 'hidden-terminal';
        input.before(wrap);
        wrap.append(input);
        wrap.style.display = 'none';
        (window as any).app._hideWebviewLayer = () => {
          wrap.style.display = '';
        };
      });
      await page.locator('#other').tap();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('retires the previous text selection guard on an explicit tab tap', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate(() => {
        const app = (window as any).app;
        app._touchSelecting = true;
        app._clearTouchSelection = () => {
          app._touchSelecting = false;
        };
        document.getElementById('terminal')!.addEventListener('focus', (e) => {
          if (app._touchSelecting) (e.target as HTMLElement).blur();
        });
      });
      await page.locator('#other').tap();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
  it('uses the mobile input target after mode setup, including CJK input', async () => {
    const page = await harness(browser);
    try {
      await page.evaluate(() => {
        const field = document.createElement('textarea');
        field.id = 'cjkInput';
        document.body.append(field);
        (window as any).app._focusMobileTerminalInput = () => field.focus();
      });
      await page.locator('#other').tap();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cjkInput');
    } finally {
      await page.close();
    }
  });
  it('preserves desktop selection focus', async () => {
    const page = await harness(browser, false);
    try {
      await page.locator('#other').click();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
    } finally {
      await page.close();
    }
  });
});

describe('mobile sheet delayed search focus', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  it('cancels pending search focus on a quick selection and leaves input on the terminal', async () => {
    const page = await harness(browser);
    try {
      await page.addStyleTag({ content: readFileSync(resolve(publicDir, 'mobile.css'), 'utf8') });
      await page.evaluate(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          '<button id="mobileTabPill"></button><div id="mobileTabScrim"></div><div id="mobileTabSheet" class="mobile-tab-sheet"><input id="mobileTabSearch"></div>'
        );
      });
      await page.addScriptTag({
        content: `window.MobileTabSheet={${['toggle', 'activate', 'isOpen'].map((n) => method('mobile-tabs.js', n)).join(',')},render(){}};`,
      });
      await page.evaluate('MobileTabSheet.toggle(true);MobileTabSheet.activate("b")');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
      await page.waitForTimeout(320);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
      expect(await page.evaluate('MobileTabSheet.isOpen()')).toBe(false);
      await page.screenshot({ path: '/tmp/mobile-tab-keyboard-focus.png' });
    } finally {
      await page.close();
    }
  });
});

describe('header-menu workaround and stale keyboard visibility', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  async function keyboardPage() {
    const page = await browser.newPage({ viewport: { width: 440, height: 852 }, hasTouch: true, isMobile: true });
    await page.setContent(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><div class="app"><header class="header"><button id="menu" class="mobile-header-utility-toggle">Menu</button></header><textarea id="terminal" class="xterm-helper-textarea"></textarea></div>'
    );
    await page.addScriptTag({
      content: `
      window.MobileDetection={isTouchDevice:()=>true,updateAppHeight(){}};
      window.hideEvents=0;window.focusEvents=0;
      window.KeyboardHandler={${method('mobile-handlers.js', 'handleViewportResize')},
        keyboardVisible:true,initialViewportHeight:visualViewport.height,
        _keyboardMinHeight:visualViewport.height-300,lastViewportWidth:visualViewport.width,
        KEYBOARD_GONE_GROWTH_PX:150,_releaseHeldRows(){return false},onKeyboardHide(){hideEvents++},
        onKeyboardShow(){},updateLayoutForKeyboard(){},_deferViewportSettle(){},_scheduleViewportSettle(){}};
      window.app={${['_mobileKeyboardIsUp', '_focusMobileTerminalInput', '_isMobileTerminalInputFocused', '_blurMobileTerminalInput'].map((n) => method('terminal-ui.js', n)).join(',')},
        ${method('app.js', 'toggleMobileHeaderUtilities')},_syncMobileHelperTextareaToCursor(){},
        terminal:{textarea:document.getElementById('terminal'),focus(){this.textarea.focus()}}};
      document.getElementById('menu').onclick=()=>app.toggleMobileHeaderUtilities();
      app.terminal.focus();
      document.getElementById('terminal').addEventListener('focus',()=>focusEvents++);
    `,
    });
    return page;
  }
  it('creates a fresh focus without requiring the header-menu detour when a hide resize was missed', async () => {
    const page = await keyboardPage();
    try {
      await page.evaluate('app._focusMobileTerminalInput()');
      expect(await page.evaluate('focusEvents')).toBe(1);
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(false);
      expect(await page.evaluate('hideEvents')).toBe(1);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('terminal');
      await page.locator('#menu').tap();
      expect(await page.locator('#menu').getAttribute('aria-expanded')).toBe('true');
      await page.evaluate('focusEvents=0;app._focusMobileTerminalInput()');
      expect(await page.evaluate('focusEvents')).toBe(1);
    } finally {
      await page.close();
    }
  });
  it('does not blur/refocus an actually shrunken keyboard viewport', async () => {
    const page = await keyboardPage();
    try {
      await page.setViewportSize({ width: 440, height: 552 });
      await page.evaluate(
        'KeyboardHandler._keyboardMinHeight=visualViewport.height;focusEvents=0;app._focusMobileTerminalInput()'
      );
      expect(await page.evaluate('focusEvents')).toBe(0);
      expect(await page.evaluate('hideEvents')).toBe(0);
      expect(await page.evaluate('KeyboardHandler.keyboardVisible')).toBe(true);
    } finally {
      await page.close();
    }
  });
});
