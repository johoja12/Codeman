/** @fileoverview Browser coverage for COD-343 Case Management default groups. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';

const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
const groups = [
  { id: 'group-nzbdav', name: 'nzbdav' },
  { id: 'group-tcc', name: 'tcc' },
];

describe('COD-343 Case Management default groups in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let rejectLoad = false;
  let updateBodies: unknown[];

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route('**/api/cases/sandbox', async (route: Route) => {
      updateBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      });
    });
    await page.route('**/api/cases/*/default-group', async (route: Route) => {
      if (rejectLoad) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Load rejected' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { groupId: 'group-tcc', groups } }),
      });
    });
  });

  beforeEach(async () => {
    rejectLoad = false;
    updateBodies = [];
    await page.setContent(`<!doctype html><html><head><base href="http://codeman.test/"></head><body>
      <div id="createCaseModal"><button class="set-rail-item"></button></div>
      <input id="dockerCaseName"><input id="dockerWorkspacePath"><input id="dockerHostId"><input id="dockerImage">
      <select id="dockerNetwork"><option value="bridge">bridge</option></select>
      <div id="caseEditDefaultGroupRow" class="hidden">
        <select id="caseEditDefaultGroup" disabled><option value="">Ungrouped</option></select>
      </div>
    </body></html>`);
    await page.addScriptTag({
      content: `class CodemanApp {}\n${sessionUi}\nwindow.__app = Object.create(CodemanApp.prototype);`,
    });
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.caseEditOriginalName = 'nzbdav';
      app.resetCaseModalFields = () => {};
      app.switchCaseModalTab = (tab: string) => (app.selectedCaseModalTab = tab);
      (window as any).__toasts = [];
      app.showToast = (message: string, kind: string) => ((window as any).__toasts ??= []).push({ message, kind });
    });
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
  });

  async function newCaseForm() {
    await page.route('**/api/tab-layout', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { layout: { groups } } }),
      })
    );
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.caseEditOriginalName = null;
      app.loadQuickStartCases = async () => {};
      app.saveLastUsedCase = async () => {};
      document.body.insertAdjacentHTML(
        'beforeend',
        '<input id="linkCaseName" value="fresh"><input id="linkCasePath" value="/tmp/fresh"><input id="newCaseName" value="fresh"><input id="newCaseDescription"><input type="checkbox" id="newCaseDocker">'
      );
    });
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup(null));
    expect(await page.locator('#caseEditDefaultGroup').isEnabled()).toBe(true);
    await page.selectOption('#caseEditDefaultGroup', 'group-tcc');
  }

  it('loads selectable owner groups for a new case and saves the choice before closing Link Case', async () => {
    await newCaseForm();
    const requests: unknown[] = [];
    await page.route('**/api/cases/link', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    });
    await page.route('**/api/cases/fresh/default-group', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    });
    await page.evaluate(() => (window as any).__app.linkCase());
    expect(requests).toEqual([
      { name: 'fresh', path: '/tmp/fresh', codexCommandSelection: { kind: 'default' } },
      { groupId: 'group-tcc' },
    ]);
    expect(await page.evaluate(() => (window as any).__app.caseEditOriginalName)).toBeNull();
  });

  it('saves a remote case group after linking without contacting a real host', async () => {
    await newCaseForm();
    await page.evaluate(() => {
      const values: Record<string, string> = {
        remoteCaseName: 'fresh',
        remoteCasePath: '/srv/fresh',
        remoteHostId: 'test',
        remoteHostAddress: 'example.test',
        remoteHostUsername: 'test',
        remoteHostPort: '',
        remoteHostIdentityFile: '',
        remoteHostSocksProxy: '',
        remoteHostJumpHost: '',
        remoteHostWakeMac: '',
        remoteHostWakeCommand: '',
        remoteHostExtraSshOptions: '',
      };
      for (const [id, value] of Object.entries(values)) {
        const input = document.createElement('input');
        input.id = id;
        input.value = value;
        document.body.append(input);
      }
    });
    for (const endpoint of ['remote-hosts', 'cases/remote-link'])
      await page.route(`**/api/${endpoint}`, (route) =>
        route.fulfill({ contentType: 'application/json', body: '{"success":true}' })
      );
    let saved: unknown;
    await page.route('**/api/cases/fresh/default-group', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    });
    await page.evaluate(() => (window as any).__app.linkRemoteCase());
    expect(saved).toEqual({ groupId: 'group-tcc' });
  });

  it('does not start a Docker session if case creation succeeds but saving the group fails', async () => {
    await newCaseForm();
    await page.locator('#newCaseDocker').check();
    await page.evaluate(() => {
      const app = (window as any).__app;
      app._collectDockerQuickSettings = () => ({});
      (window as any).__started = false;
      app.runClaude = async () => {
        (window as any).__started = true;
      };
    });
    await page.route('**/api/cases/docker-quickcreate', (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"success":true,"data":{}}' })
    );
    await page.route('**/api/cases/fresh/default-group', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: '{"success":false,"error":"Group removed"}' })
    );
    await page.evaluate(() => (window as any).__app.createCase());
    expect(await page.evaluate(() => (window as any).__started)).toBe(false);
    expect(await page.evaluate(() => (window as any).__toasts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'error', message: expect.stringContaining('Case created, but') }),
      ])
    );
  });

  it('ignores a new-case group response after the dialog has switched to an existing case', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/tab-layout', async (route) => {
      await waiting;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { layout: { groups } } }),
      });
    });
    const requested = page.waitForRequest('**/api/tab-layout');
    await page.evaluate(() => {
      const a = (window as any).__app;
      a.caseEditOriginalName = null;
      void a.loadCaseEditDefaultGroup(null);
    });
    await requested;
    await page.evaluate(async () => {
      const a = (window as any).__app;
      a.caseEditOriginalName = 'sandbox';
      await a.loadCaseEditDefaultGroup('sandbox');
    });
    release();
    await page.waitForTimeout(150);
    expect(await page.locator('#caseEditDefaultGroup').inputValue()).toBe('group-tcc');
  });

  it('loads the saved default into the Edit Case control and exposes its selected ID for the case update', async () => {
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup('nzbdav'));

    await expect.poll(() => page.locator('#caseEditDefaultGroup').inputValue()).toBe('group-tcc');
    expect(
      await page.locator('#caseEditDefaultGroupRow').evaluate((element) => element.classList.contains('hidden'))
    ).toBe(false);
    expect(await page.locator('#caseEditDefaultGroup option').allTextContents()).toEqual([
      'Ungrouped',
      'nzbdav',
      'tcc',
    ]);

    await page.selectOption('#caseEditDefaultGroup', 'group-nzbdav');
    expect(await page.evaluate(() => (window as any).__app._caseEditDefaultGroupId())).toBe('group-nzbdav');
  });

  it('keeps the Edit Case control disabled when its authoritative value fails to load', async () => {
    rejectLoad = true;
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup('nzbdav'));

    await expect.poll(() => page.locator('#caseEditDefaultGroup').isDisabled()).toBe(true);
    expect(await page.locator('#caseEditDefaultGroup option').allTextContents()).toEqual(['Ungrouped']);
    expect(await page.evaluate(() => (window as any).__app._caseEditDefaultGroupId())).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__toasts)).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('Load rejected') }),
    ]);
  });

  it('opens a Docker case on its Docker edit panel before loading the shared default group', async () => {
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.cases = [
        {
          name: 'sandbox',
          location: 'docker',
          docker: { path: '/srv/sandbox', hostId: 'local', image: 'codeman/agent:base', network: 'bridge' },
        },
      ];
      return app.editCase('sandbox');
    });

    await expect.poll(() => page.locator('#caseEditDefaultGroup').isEnabled()).toBe(true);
    expect(await page.evaluate(() => (window as any).__app.selectedCaseModalTab)).toBe('case-docker');
    expect(await page.locator('#dockerCaseName').inputValue()).toBe('sandbox');
    expect(await page.locator('#dockerWorkspacePath').isDisabled()).toBe(true);
  });

  it('saves the Edit Case selection with the normal case update request', async () => {
    await page.evaluate(() => {
      const app = (window as any).__app;
      app.caseEditOriginalName = 'sandbox';
      app.caseEditOriginalLocation = 'docker';
      (document.getElementById('dockerCaseName') as HTMLInputElement).value = 'sandbox';
      app.closeCreateCaseModal = () => {};
      app.loadQuickStartCases = async () => {};
      app.saveLastUsedCase = async () => {};
    });
    await page.evaluate(() => (window as any).__app.loadCaseEditDefaultGroup('sandbox'));
    await expect.poll(() => page.locator('#caseEditDefaultGroup').isEnabled()).toBe(true);
    await page.selectOption('#caseEditDefaultGroup', 'group-nzbdav');
    await page.evaluate(() => (window as any).__app.updateCase());

    await expect.poll(() => updateBodies).toEqual([{ name: 'sandbox', defaultGroupId: 'group-nzbdav' }]);
  });

  it('reenables Docker configuration fields after closing an edited Docker case', async () => {
    await page.evaluate(() => {
      for (const id of ['dockerWorkspacePath', 'dockerHostId', 'dockerImage', 'dockerNetwork']) {
        (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).disabled = true;
      }
      (window as any).__app.resetCaseEditState();
    });

    for (const id of ['dockerWorkspacePath', 'dockerHostId', 'dockerImage', 'dockerNetwork']) {
      expect(await page.locator(`#${id}`).isEnabled()).toBe(true);
    }
  });
});
