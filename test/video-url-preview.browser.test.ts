import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const clipPath = resolve(import.meta.dirname, 'fixtures/media/preview.mp4');
const videoUrl = 'https://media.example.test/generated%20preview.MP4?token=a%2Bb&download=0#t=0.2';
let server: WebServer;
let browser: Browser;
let base: string;

async function openPage(mobile = false): Promise<Page> {
  const page = await browser.newPage({
    viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 850 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  await page.route('https://media.example.test/**', async (route) => {
    if (route.request().url().includes('broken.mp4')) {
      await route.fulfill({ status: 404, body: 'Not found' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      path: clipPath,
      headers: { 'Accept-Ranges': 'bytes' },
    });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.xterm', { state: 'attached' });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return page;
}

async function expectPlaying(page: Page) {
  await page.waitForFunction(
    () => {
      const video = document.querySelector<HTMLVideoElement>('#filePreviewBody video');
      return video && (video.error || (video.readyState >= 1 && video.duration > 0));
    },
    undefined,
    { timeout: 10000 }
  );
  const error = await page
    .locator('#filePreviewBody video')
    .evaluate((el: HTMLVideoElement) => el.error?.message || null);
  expect(error).toBeNull();
  await page.evaluate(`document.querySelector('#filePreviewBody video').play()`);
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('#filePreviewBody video')!.currentTime > 0);
}

describe('linked video previews', () => {
  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://127.0.0.1:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  for (const { mobile, labelled } of [
    { mobile: false, labelled: false },
    { mobile: true, labelled: false },
    { mobile: false, labelled: true },
    { mobile: true, labelled: true },
  ]) {
    it(`plays a signed ${labelled ? 'labelled' : 'plain'} video link on ${mobile ? 'mobile' : 'desktop'} and unloads on close`, async () => {
      const page = await openPage(mobile);
      const popups: Page[] = [];
      page.on('popup', (popup) => popups.push(popup));
      try {
        await page.evaluate('window.__videoTestApp = app');
        const renderedLink = labelled ? `\x1b]8;;${videoUrl}\x07Watch preview\x1b]8;;\x07` : videoUrl;
        const point = await page.evaluate(async (url) => {
          // Exercise the terminal's real link provider and touch/click path.
          const app = (window as any).__videoTestApp;
          app.hideWelcome();
          app.terminal.reset();
          await new Promise<void>((resolve) => app.terminal.write(url + '\r\n', resolve));
          const rect = app.terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
          const cell = app.terminal._core._renderService.dimensions.css.cell;
          return { x: rect.left + cell.width * 8.5, y: rect.top + cell.height * 0.5 };
        }, renderedLink);
        if (mobile) await page.touchscreen.tap(point.x, point.y);
        else {
          await page.mouse.move(point.x, point.y);
          await page.waitForTimeout(150);
          await page.mouse.click(point.x, point.y);
        }
        await page.waitForSelector('#filePreviewOverlay.visible');
        expect(await page.locator('#filePreviewOverlay').isVisible()).toBe(true);
        expect(await page.locator('#filePreviewTitle').textContent()).toBe('generated preview.MP4');
        expect(await page.locator('#filePreviewBody video').getAttribute('src')).toBe(videoUrl);
        expect(await page.locator('#filePreviewBody video').getAttribute('controls')).not.toBeNull();
        expect(await page.locator('#filePreviewBody video').getAttribute('playsinline')).not.toBeNull();
        await expectPlaying(page);
        await page.evaluate(`document.querySelector('#filePreviewBody video').currentTime = 1`);
        await page.waitForFunction(
          () => document.querySelector<HTMLVideoElement>('#filePreviewBody video')!.currentTime >= 1
        );
        const viewport = page.viewportSize()!;
        const box = await page.locator('#filePreviewBody video').boundingBox();
        expect(box!.width).toBeLessThanOrEqual(viewport.width);
        expect(box!.height).toBeLessThanOrEqual(viewport.height);
        expect(popups).toHaveLength(0);
        await page.screenshot({ path: `/tmp/codeman-video-preview-${mobile ? 'mobile' : 'desktop'}.png` });
        await page.evaluate(`window.__oldVideo = document.querySelector('#filePreviewBody video')`);
        await page.keyboard.press('Escape');
        expect(await page.locator('#filePreviewOverlay').isVisible()).toBe(false);
        expect(await page.evaluate(`window.__oldVideo.paused && !window.__oldVideo.getAttribute('src')`)).toBe(true);
      } finally {
        await page.close();
      }
    });
  }

  it('opens a response link on a real click, stops the prior video on replacement, and offers error fallback', async () => {
    const page = await openPage();
    try {
      await page.evaluate(`(() => {
        const body = document.createElement('div'); body.id='video-link-test';
        body.innerHTML='<a target="_blank" href="${videoUrl.replaceAll('&', '&amp;')}">Watch preview</a>';
        document.body.append(body); app._bindResponseViewerInteractions(body);
      })()`);
      await page.locator('#video-link-test a').click();
      await expectPlaying(page);
      await page.evaluate(
        `window.__oldVideo = document.querySelector('#filePreviewBody video'); app._openTerminalUrl('https://media.example.test/broken.mp4')`
      );
      expect(await page.evaluate(`window.__oldVideo.paused && !window.__oldVideo.getAttribute('src')`)).toBe(true);
      await page.waitForFunction(() =>
        document.getElementById('filePreviewFooter')!.textContent!.includes('could not play')
      );
      expect(await page.locator('#filePreviewOpenNewTab').isEnabled()).toBe(true);
      expect(await page.evaluate(`app.filePreviewState.externalPreviewUrl`)).toBe(
        'https://media.example.test/broken.mp4'
      );
    } finally {
      await page.close();
    }
  });

  it('permits external media in CSP while retaining script and frame restrictions', async () => {
    const response = await fetch(base);
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain("media-src 'self' blob: https: http:");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;");
    expect(csp).toContain("frame-ancestors 'self'");
  });
});
