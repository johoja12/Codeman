import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

describe('mobile case search with the keyboard visible (#12)', () => {
  let server: WebServer;
  let browser: Browser;
  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  for (const [visibleHeight, keyboardFirst] of [
    [500, false],
    [340, false],
    [260, false],
    [340, true],
    [260, true],
  ] as const) {
    it(`keeps matching rows in ${visibleHeight}px (keyboard first: ${keyboardFirst})`, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
      try {
        await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).app?.showMobileCasePicker);
        await page.waitForTimeout(3500);
        await page.evaluate(() => {
          const app = (window as any).app;
          app.getCasePickerOptions = () =>
            Array.from({ length: 30 }, (_, i) => ({
              name: i === 0 ? 'buildmesh' : `case-${i}`,
              label: i === 0 ? 'Buildmesh' : `Case ${i}`,
            }));
          app.showMobileCasePicker();
          const body = document.querySelector('.mobile-case-picker-body')!;
          body.scrollTop = body.scrollHeight;
        });
        await page.waitForTimeout(250);
        // First input can arrive before the keyboard animation completes.
        if (!keyboardFirst) await page.locator('#mobileCaseSearch').fill('bu');
        await page.evaluate((height) => {
          Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: {
              width: 390,
              height,
              offsetTop: 30,
              offsetLeft: 0,
              addEventListener() {},
              removeEventListener() {},
            },
          });
          // Drive the actual keyboard layout code with iOS's separate visual viewport.
          const handler = (0, eval)('KeyboardHandler');
          handler.keyboardVisible = true;
          handler.initialViewportHeight = 844;
          document.body.classList.add('keyboard-visible');
          handler.updateLayoutForKeyboard();
        }, visibleHeight);
        if (keyboardFirst) {
          await page.evaluate(() => {
            const app = (window as any).app;
            app.closeMobileCasePicker();
            void document.body.offsetHeight;
            app.showMobileCasePicker();
          });
          await page.locator('#mobileCaseSearch').fill('bu');
        }
        await page.waitForTimeout(250);
        const layout = await page.evaluate(() => {
          const sheet = document.querySelector('.mobile-case-picker-sheet')!;
          const body = document.querySelector('.mobile-case-picker-body')!;
          const row = document.querySelector('.mobile-case-item:not([hidden])')!;
          const rect = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, height: r.height };
          };
          return {
            footer: rect(document.querySelector('.mobile-case-picker-footer')!),
            sheet: rect(sheet),
            body: rect(body),
            row: rect(row),
            search: rect(document.getElementById('mobileCaseSearch')!),
            minHeight: (body as HTMLElement).style.minHeight,
            visualTop: window.visualViewport!.offsetTop,
            visualBottom: window.visualViewport!.offsetTop + window.visualViewport!.height,
          };
        });
        if (process.env.UI_SCREENSHOT_DIR)
          await page.screenshot({ path: `${process.env.UI_SCREENSHOT_DIR}/case-search-${visibleHeight}.png` });
        expect(layout.sheet.top).toBeGreaterThanOrEqual(layout.visualTop);
        expect(layout.sheet.bottom).toBeLessThanOrEqual(layout.visualBottom + 1);
        expect(layout.body.height).toBeGreaterThanOrEqual(44);
        expect(layout.body.bottom).toBeLessThanOrEqual(layout.footer.top + 1);
        expect(layout.footer.bottom).toBeLessThanOrEqual(layout.visualBottom + 1);
        expect(layout.row.top).toBeGreaterThanOrEqual(Math.max(layout.body.top, layout.visualTop));
        expect(layout.row.bottom).toBeLessThanOrEqual(Math.min(layout.body.bottom, layout.visualBottom));
        await page.locator('#mobileCaseSearch').fill('no-match');
        expect(await page.locator('#mobileCaseEmpty').isVisible()).toBe(true);
        await page.locator('#mobileCaseSearch').fill('');
        expect(await page.locator('.mobile-case-item:not([hidden])').count()).toBe(30);
        await page.evaluate(() => {
          const handler = (0, eval)('KeyboardHandler');
          handler.keyboardVisible = false;
          document.body.classList.remove('keyboard-visible');
          handler.resetLayout();
        });
        expect(
          await page.locator('.mobile-case-picker-sheet').evaluate((el) => ({
            transform: (el as HTMLElement).style.transform,
            maxHeight: (el as HTMLElement).style.maxHeight,
          }))
        ).toEqual({ transform: '', maxHeight: '' });
        await page.locator('#mobileCaseSearch').fill('buildmesh');
        await page.evaluate(() => {
          (window as any).app.selectMobileCase = (name: string) => {
            (window as any).chosenCase = name;
          };
        });
        await page.locator('.mobile-case-item:not([hidden])').click();
        expect(await page.evaluate(() => (window as any).chosenCase)).toBe('buildmesh');
      } finally {
        await page.close();
      }
    });
  }
});
