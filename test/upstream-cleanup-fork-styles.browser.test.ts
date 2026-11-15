/** @fileoverview Fork surfaces still using selectors removed by upstream's dead-code cleanup. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

const publicDir = join(process.cwd(), 'src/web/public');
const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const skills = html.match(/<section class="set-section" id="settings-skills"[\s\S]*?<\/section>/)![0];
const css = ['styles.css', 'mobile.css'].map((name) => readFileSync(join(publicDir, name), 'utf8')).join('\n');

describe('fork surfaces after upstream CSS cleanup', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each([390, 1440])('keeps Skills layout and file filtering at width %i', async (width) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<style>${css}</style>${skills}<div class="file-tree-item hidden-by-filter" id="filtered">other.txt</div><div class="file-tree-item" id="matched">match.txt</div>`
      );
      const grid = await page.locator('#settings-skills .settings-grid').evaluate((el) => ({
        display: getComputedStyle(el).display,
        columns: getComputedStyle(el).gridTemplateColumns.split(' ').length,
      }));
      expect(grid).toEqual({ display: 'grid', columns: width < 600 ? 1 : 2 });
      expect(await page.locator('#filtered').isVisible()).toBe(false);
      expect(await page.locator('#matched').isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });
});
