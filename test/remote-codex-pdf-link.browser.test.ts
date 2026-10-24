import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

const id = 'pdf-link-probe';
const path = '/Users/example/contexts/other-project/output/pdf/upgrade-plan.pdf';
const uri = `file://${path}`;

describe('remote Codex PDF links (#16)', () => {
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

  for (const kind of ['desktop', 'native hyperlink', 'mobile tap']) {
    it(`${kind} opens the guarded preview and requires explicit allow-once`, async () => {
      const page = await browser.newPage({
        viewport: kind === 'mobile tap' ? { width: 393, height: 852 } : { width: 1500, height: 850 },
        hasTouch: true,
      });
      const bodies: unknown[] = [];
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route(`**/api/sessions/${id}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/file-uri-preview')) {
          const body = route.request().postDataJSON();
          bodies.push(body);
          await route.fulfill({
            status: body.allowUnlistedPath ? 200 : 403,
            contentType: 'application/json',
            body: JSON.stringify(
              body.allowUnlistedPath
                ? { success: true, data: { attachmentId: 'pdf-fixture', fileName: 'upgrade-plan.pdf' } }
                : { success: false, error: 'Access to this file is blocked' }
            ),
          });
        } else if (url.pathname.endsWith('/attachments/pdf-fixture')) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: {
                type: 'pdf',
                extension: 'pdf',
                size: 121499,
                mtimeMs: 1,
                url: `/api/sessions/${id}/attachments/pdf-fixture/raw`,
              },
            }),
          });
        } else if (url.pathname.endsWith('/raw')) {
          await route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF\n' });
        } else
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ success: true, data: [] }),
          });
      });
      try {
        await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).app?.terminal);
        await page.waitForTimeout(3500);
        const point = await page.evaluate(
          async ({ id, path, uri, native }) => {
            const app = (window as any).app;
            app.activeSessionId = id;
            app.sessions.set(id, {
              id,
              mode: 'codex',
              workingDir: '/Users/example/contexts/saif',
              remote: { hostId: 'remote-fixture' },
              cliMouseTracking: true,
            });
            app.hideWelcome();
            app.closeFilePreview();
            (window as any).pdfTestInputs = [];
            app._sendInputEphemeral = (...args: unknown[]) => (window as any).pdfTestInputs.push(args);
            app.terminal.reset();
            const text = native ? `\x1b]8;;${uri}\x1b\\${path}\x1b]8;;\x1b\\` : path;
            await new Promise<void>((resolve) =>
              app.terminal.write(`• Created the illustrated upgrade plan PDF (${text}).\r\n`, resolve)
            );
            app.terminal.scrollToBottom();
            const t = app.terminal;
            let link: any;
            for (let row = 1; row <= t.buffer.active.length && !link; row++) {
              app._terminalFilePathLinkProvider.provideLinks(row, (links: any[]) => {
                link = links?.find((l) => l.text === path);
              });
            }
            if (!link) throw new Error('PDF path has no clickable range');
            const rect = t.element.querySelector('.xterm-screen').getBoundingClientRect();
            const cell = t._core._renderService.dimensions.css.cell;
            return {
              x: rect.left + (link.range.start.x - 0.5) * cell.width,
              y: rect.top + (link.range.start.y - t.buffer.active.viewportY - 0.5) * cell.height,
            };
          },
          { id, path, uri, native: kind === 'native hyperlink' }
        );
        if (kind === 'mobile tap') await page.touchscreen.tap(point.x, point.y);
        else {
          await page.mouse.move(point.x, point.y);
          await page.waitForTimeout(250);
          await page.mouse.click(point.x, point.y);
        }
        const allow = page.locator('.file-preview-allow-once');
        await allow.waitFor({ state: 'visible', timeout: 8000 });
        expect(bodies).toEqual([{ uri }]);
        expect(await page.locator('#filePreviewOverlay').getAttribute('class')).toContain('visible');
        await allow.click();
        try {
          await page.locator('#filePreviewBody iframe').waitFor({ state: 'visible', timeout: 6000 });
        } catch {
          throw new Error(
            JSON.stringify({ bodies, errors, preview: await page.locator('#filePreviewBody').innerText() })
          );
        }
        expect(await page.locator('#filePreviewBody iframe').getAttribute('src')).toContain(
          `/api/sessions/${id}/attachments/pdf-fixture/raw`
        );
        expect(bodies).toEqual([{ uri }, { uri, allowUnlistedPath: true }]);
        expect(await page.evaluate(() => (window as any).pdfTestInputs)).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
});
