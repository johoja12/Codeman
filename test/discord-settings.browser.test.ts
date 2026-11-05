/** Real API and Chromium Settings verification; bridge stays disabled, no real Discord traffic. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const exec = promisify(execFile);
const screenshots = '/tmp/codeman-discord-interface-screenshots';

describe('Discord interface mode Settings', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let base: string;
  const errors: string[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://127.0.0.1:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await mkdir(screenshots, { recursive: true });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  async function openSettings() {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.waitForFunction(() => document.getElementById('discordGroup')?.style.display !== 'none');
    await page.waitForTimeout(3500);
    await page.locator('#discordMode').scrollIntoViewIfNeeded();
  }

  it('round-trips mode through curl without enabling or exposing a token', async () => {
    const get = JSON.parse((await exec('curl', ['-fsS', `${base}/api/discord`])).stdout);
    expect(get.data).toMatchObject({ enabled: false, mode: 'notifications', sessionSync: { state: 'idle' } });
    const deliveries = JSON.parse((await exec('curl', ['-fsS', `${base}/api/discord/deliveries`])).stdout);
    expect(deliveries).toEqual({ success: true, data: [] });
    const put = JSON.parse(
      (
        await exec('curl', [
          '-fsS',
          '-X',
          'PUT',
          '-H',
          'Content-Type: application/json',
          '--data',
          '{"mode":"full"}',
          `${base}/api/discord`,
        ])
      ).stdout
    );
    expect(put.data).toMatchObject({ enabled: false, mode: 'full' });
    expect(put.data).not.toHaveProperty('token');
    await exec('curl', [
      '-fsS',
      '-X',
      'PUT',
      '-H',
      'Content-Type: application/json',
      '--data',
      '{"mode":"notifications"}',
      `${base}/api/discord`,
    ]);
  });

  it('shows the desktop mode switch, preview limits and preserves the legacy creation preference', async () => {
    await openSettings();
    expect(await page.inputValue('#discordMode')).toBe('notifications');
    expect(await page.isVisible('#discordSyncRow')).toBe(false);
    await page.selectOption('#discordThreadCreation', 'lazy');
    await page.selectOption('#discordMode', 'full');
    expect(await page.isDisabled('#discordThreadCreation')).toBe(true);
    expect(await page.isVisible('#discordSyncRow')).toBe(true);
    expect(await page.textContent('#discordModeHint')).toContain('does not yet replace the web UI');
    await page.click('#discordSaveBtn');
    await page.waitForFunction(async () => (await (await fetch('/api/discord')).json()).data.mode === 'full');
    await page.locator('#discordMode').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/desktop.png` });
    const data = await page.evaluate(async () => (await (await fetch('/api/discord')).json()).data);
    expect(data).toMatchObject({ enabled: false, mode: 'full', threadCreation: 'lazy' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal);
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.waitForFunction(() => (document.getElementById('discordMode') as HTMLSelectElement)?.value === 'full');
    await page.locator('#discordMode').scrollIntoViewIfNeeded();
    await page.selectOption('#discordMode', 'notifications');
    expect(await page.isDisabled('#discordThreadCreation')).toBe(false);
    expect(await page.inputValue('#discordThreadCreation')).toBe('lazy');
    expect(await page.isVisible('#discordSyncRow')).toBe(false);
    await page.click('#discordSaveBtn');
  });

  it('supports touch/mobile mode selection and displays disabled-sync feedback', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const mobile = await context.newPage();
    mobile.on('pageerror', (e) => errors.push(e.message));
    await mobile.goto(base, { waitUntil: 'domcontentloaded' });
    await mobile.waitForFunction(() => (window as any).app?.terminal);
    await mobile.evaluate(() => (window as any).app.openAppSettings());
    await mobile.waitForFunction(() => document.getElementById('discordGroup')?.style.display !== 'none');
    await mobile.waitForTimeout(3500);
    await mobile.locator('#discordMode').scrollIntoViewIfNeeded();
    await mobile.selectOption('#discordMode', 'full');
    expect(await mobile.isVisible('#discordModeHint')).toBe(true);
    expect(await mobile.isDisabled('#discordThreadCreation')).toBe(true);
    const box = await mobile.locator('#discordMode').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    await mobile.screenshot({ path: `${screenshots}/mobile.png` });
    await mobile.locator('#discordSyncBtn').tap();
    await mobile.waitForFunction(() =>
      /Enable Full interface/.test(document.getElementById('discordResult')?.textContent ?? '')
    );
    expect(await mobile.isDisabled('#discordSyncBtn')).toBe(false);
    await context.close();
  });

  it('has no browser runtime errors', () => {
    expect(errors).toEqual([]);
  });
});
