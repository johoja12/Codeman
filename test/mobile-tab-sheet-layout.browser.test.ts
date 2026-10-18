import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

// Real page/styles and sheet renderer; in-memory sessions never create PTYs.
describe('mobile tab sheet with a crowded session list (#11)', () => {
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

  for (const viewport of [
    { width: 440, height: 800 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    it(`keeps controls readable and only scrolls the list at ${viewport.width}x${viewport.height}`, async () => {
      const page = await browser.newPage({ viewport, hasTouch: true });
      try {
        await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).app && (window as any).MobileTabSheet);
        await page.waitForTimeout(3500);
        await page.evaluate(() => {
          const app = (window as any).app;
          const ids = Array.from({ length: 19 }, (_, i) => `layout-${i}`);
          app.sessions = new Map(
            ids.map((id, i) => [
              id,
              {
                id,
                name: i === 0 ? 'w1-mini-me' : `w${i + 1}-buildmesh`,
                mode: i % 2 ? 'claude' : 'codex',
                status: i === 1 ? 'busy' : 'idle',
              },
            ])
          );
          app.sessionOrder = ids;
          app.activeSessionId = ids[0];
          app.tabAlerts = new Map([[ids[2], 'action']]);
          app.pendingHooks = new Map();
          app.tabLayout = {
            version: 0,
            groups: [{ id: 'buildmesh', name: 'Buildmesh', refs: ids.slice(1).map((id) => ({ kind: 'session', id })) }],
            ungrouped: [{ kind: 'session', id: ids[0] }],
          };
          // Selection is captured without connecting a terminal or sending input.
          app.selectSession = (id: string) => {
            (window as any).selectedLayoutSession = id;
          };
          (window as any).MobileTabSheet.toggle(true);
        });
        await page.waitForTimeout(400);
        const geometry = await page.evaluate(() => {
          const sheet = document.querySelector('#mobileTabSheet')!;
          const filters = sheet.querySelector('.sheet-filters')!;
          const list = sheet.querySelector('.sheet-list')!;
          const search = sheet.querySelector('.sheet-search')!;
          const footer = sheet.querySelector('.sheet-footer')!;
          return {
            chips: [...filters.querySelectorAll('button')].map((chip) => {
              const rect = chip.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(chip);
              const text = range.getBoundingClientRect();
              return {
                height: rect.height,
                textTop: text.top,
                textBottom: text.bottom,
                top: rect.top,
                bottom: rect.bottom,
              };
            }),
            filtersBottom: filters.getBoundingClientRect().bottom,
            listTop: list.getBoundingClientRect().top,
            listHeight: list.clientHeight,
            listScrollHeight: list.scrollHeight,
            searchRight: search.getBoundingClientRect().right,
            sheetTop: sheet.getBoundingClientRect().top,
            sheetBottom: sheet.getBoundingClientRect().bottom,
            footerBottom: footer.getBoundingClientRect().bottom,
            count: sheet.querySelector('.sheet-count')!.textContent,
          };
        });
        if (process.env.UI_SCREENSHOT_DIR) {
          await page.screenshot({
            path: `${process.env.UI_SCREENSHOT_DIR}/tab-sheet-${viewport.width}x${viewport.height}.png`,
          });
        }
        expect(geometry.count).toBe('19 / 19');
        for (const chip of geometry.chips) {
          expect(chip.height).toBeGreaterThanOrEqual(36);
          expect(chip.textTop).toBeGreaterThanOrEqual(chip.top);
          expect(chip.textBottom).toBeLessThanOrEqual(chip.bottom);
        }
        expect(geometry.listTop).toBeGreaterThanOrEqual(geometry.filtersBottom - 1);
        expect(geometry.listHeight).toBeGreaterThan(40);
        expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listHeight);
        expect(geometry.searchRight).toBeLessThanOrEqual(viewport.width);
        expect(geometry.sheetTop).toBeGreaterThanOrEqual(0);
        expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.sheetBottom + 1);
        await page.locator('.sheet-list').evaluate((el) => {
          el.scrollTop = 200;
        });
        expect(await page.locator('.sheet-list').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        await page.locator('#mobileTabSheet [data-filter="needs"]').click();
        expect(await page.locator('.sheet-row').count()).toBe(1);
        await page.locator('#mobileTabSheet [data-filter="all"]').click();
        await page.locator('#mobileTabSearch').fill('mini-me');
        expect(await page.locator('.sheet-row').count()).toBe(1);
        await page.locator('#mobileTabSearch').fill('');
        await page.locator('[data-sheet-group-header="buildmesh"]').click();
        expect(await page.locator('.sheet-row').count()).toBe(1);
        await page.locator('[data-sheet-group-header="buildmesh"]').click();
        expect(await page.locator('.sheet-row').count()).toBe(19);
        await page.locator('.sheet-row[data-session-id="layout-0"]').click();
        expect(await page.evaluate(() => (window as any).selectedLayoutSession)).toBe('layout-0');
        expect(await page.locator('#mobileTabSheet').getAttribute('class')).not.toContain('open');
      } finally {
        await page.close();
      }
    });
  }
});
