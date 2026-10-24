import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

describe('assistant connection controls (#18)', () => {
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

  for (const mobile of [false, true]) {
    it(`makes connection discoverable and preserves confirmation and server checks on ${mobile ? 'mobile' : 'desktop'}`, async () => {
      const page = await browser.newPage({
        viewport: mobile ? { width: 393, height: 852 } : { width: 1500, height: 1000 },
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const assistant = {
        id: 'brain-fixture',
        name: 'Brain',
        slug: 'brain',
        mode: 'codex',
        enabled: true,
        revision: 7,
        binding: { sessionId: 'session-fixture' },
        capabilities: { requestExecution: false, handedOff: true, inputLocked: true, needsAttention: false },
      };
      const handoffs: unknown[] = [];
      let rejectHandoff = true;
      let controls = 0;
      const fulfil = (route: any, data: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ success: status === 200, ...(status === 200 ? { data } : { error: data }) }),
        });
      await page.route('**/api/sessions', (route) =>
        fulfil(route, [{ id: 'session-fixture', name: 'w1-brain', mode: 'codex', pid: 123 }])
      );
      await page.route('**/api/assistants**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/handoff')) {
          handoffs.push(route.request().postDataJSON());
          if (rejectHandoff) return fulfil(route, 'Session has active input or automation', 409);
          assistant.capabilities = {
            requestExecution: true,
            handedOff: true,
            inputLocked: true,
            needsAttention: false,
          };
        } else if (path.endsWith('/take-control')) {
          controls++;
          assistant.enabled = false;
          assistant.revision++;
          assistant.capabilities.handedOff = false;
          assistant.capabilities.inputLocked = false;
        } else if (route.request().method() === 'PATCH') {
          expect(route.request().postDataJSON()).toEqual({ expectedRevision: 8, enabled: true });
          assistant.enabled = true;
          assistant.revision++;
        }
        if (path.endsWith('/tokens')) return fulfil(route, { tokens: [] });
        if (path.endsWith('/requests')) return fulfil(route, { requests: [] });
        return fulfil(route, path === '/api/assistants' ? { assistants: [assistant] } : assistant);
      });
      try {
        await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).app?.openAssistants);
        await page.waitForTimeout(3500);
        await page.evaluate(() => (window as any).app.openAssistants());
        const dialog = page.locator('#assistantsDialog');
        const panel = dialog.locator('.assistant-ownership');
        await expect.poll(() => panel.innerText()).toContain('Messaging needs attention');
        expect(await dialog.innerText()).toContain('Connection unavailable');
        expect(await dialog.innerText()).not.toContain('Handoff needed');
        expect(await dialog.getByRole('button', { name: 'Connect to messaging', exact: true }).count()).toBe(0);
        const control = panel.getByRole('button', { name: 'Take control to reconnect' });
        const box = await control.boundingBox();
        expect(box!.y + box!.height).toBeLessThan(mobile ? 852 : 1000);
        expect((await panel.boundingBox())!.y).toBeLessThan(
          (await dialog.locator('.assistant-tiles').boundingBox())!.y
        );
        await page.screenshot({ path: `/tmp/codeman-18-${mobile ? 'mobile' : 'desktop'}-unavailable.png` });
        await control.click();
        await dialog.getByRole('button', { name: 'Enable assistant', exact: true }).waitFor();
        expect(controls).toBe(1);
        const connect = () => dialog.getByRole('button', { name: 'Connect to messaging', exact: true });
        expect(await connect().isDisabled()).toBe(true);
        await dialog.getByRole('button', { name: 'Enable assistant', exact: true }).click();
        await expect.poll(() => connect().isEnabled()).toBe(true);
        await connect().hover();
        expect(await connect().evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(199, 177, 250)');
        await page.screenshot({ path: `/tmp/codeman-18-${mobile ? 'mobile' : 'desktop'}-connect.png` });
        page.once('dialog', async (d) => {
          expect(d.message()).toContain('terminal input is empty, no task is running');
          expect(d.message()).toContain('no direct tmux attachment');
          expect(d.message()).toContain('w1-brain');
          await d.dismiss();
        });
        await connect().click();
        expect(handoffs).toEqual([]);
        page.once('dialog', (d) => d.accept());
        await connect().click();
        await expect.poll(() => page.locator('#assistantsError').innerText()).toContain('active input or automation');
        expect(await panel.innerText()).not.toContain('Messaging is in control');
        expect(handoffs).toEqual([{ expectedRevision: 9, composerEmpty: true }]);
        rejectHandoff = false;
        page.once('dialog', (d) => d.accept());
        await connect().click();
        await expect.poll(() => panel.innerText()).toContain('Messaging is in control');
        expect(await dialog.innerText()).toContain('Ready');
        expect(handoffs).toHaveLength(2);
        assistant.capabilities.needsAttention = true;
        assistant.capabilities.requestExecution = false;
        await page.evaluate(() => (window as any).app.refreshAssistants());
        await expect.poll(() => panel.innerText()).toContain('Review needed before messaging resumes');
        expect(await panel.getByRole('button', { name: 'Take control', exact: true }).isVisible()).toBe(true);
        expect(await connect().count()).toBe(0);
        await panel.getByRole('button', { name: 'Open session', exact: true }).click();
        expect(await dialog.evaluate((d: HTMLDialogElement) => d.open)).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 60000);
  }
});
