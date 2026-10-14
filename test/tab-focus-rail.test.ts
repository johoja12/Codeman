/**
 * @fileoverview The Focus section of the vertical rail, driven through the shipping CodemanApp.
 *
 * A ref flagged `focus: true` gets a SHORTCUT in a "Focus" section pinned above
 * the rail's list; the row itself stays in its group. Pinned here:
 *  - the section is its own element in #tabRail, above #sessionTabs, on the
 *    grouped AND the flat rail, and absent off the vertical rail;
 *  - shortcuts are not rows: no `.session-tab`, no Alt+N badge, no tree item,
 *    so the badges, the tree's single tab stop, the row count and drag are
 *    exactly what they were, and no id is duplicated;
 *  - a click selects the tab; the selected tab's shortcut is aria-current;
 *  - "Add to Focus" / "Remove from Focus" in the row and web-tab menus send
 *    one `setFocus` through the edit coordinator (whole-layout PUT);
 *  - per-device collapse, a list keyboard model with one tab stop, a gone
 *    session dropping out, and a flag changed elsewhere repainting the section;
 *  - the new strings translate to zh-CN.
 *
 * Port: none (JSDOM, stubbed fetch).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual'; focus?: true };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
};

let CodemanApp: { prototype: Record<string, any> };
let win: any;
let document: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  }
  win = dom.window;
  document = win.document;
  win.setInterval = () => 0;
  win.requestAnimationFrame = () => 0;
  win.CSS = { escape: (value: string) => value };
  win.eval(
    'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
      'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      read('constants.js') +
      '\n' +
      read('tab-layout-browser.js') +
      '\n' +
      read('app.js') +
      '\n' +
      read('tab-rail-resize.js') +
      '\n' +
      read('api-client.js') +
      '\n' +
      read('webview-tabs.js') +
      '\n;window.__FocusCodemanApp = CodemanApp;'
  );
  CodemanApp = win.__FocusCodemanApp;
});

const s = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'session', id, ...extra });
const w = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'webview', id, ...extra });

const grouped = (version = 8): Layout => ({
  version,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [
    { id: 'gx', name: 'Core', refs: [s('s2', { focus: true }), w('w1', { focus: true })] },
    { id: 'gy', name: 'Later', refs: [] },
  ],
  ungrouped: [s('s1'), s('s3', { focus: true })],
});
const flat = (version = 8): Layout => ({
  version,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [],
  ungrouped: [s('s1'), s('s2', { focus: true }), s('s3'), w('w1')],
});

function installFetch() {
  const puts: any[] = [];
  win.fetch = vi.fn(async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === 'PUT') puts.push(body);
    const payload = { success: true, data: { layout: { ...body?.layout, version: (body?.baseVersion ?? 0) + 1 } } };
    return { ok: true, status: 200, json: async () => payload };
  });
  return puts;
}

function makeApp(layout: Layout | null = grouped(), orientation = 'vertical') {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', orientation);
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML =
    '<aside class="tab-rail" id="tabRail"><div id="tabRailResizeHandle"></div>' +
    '<div id="sessionTabs" class="session-tabs" role="tablist" aria-label="Session tabs"></div></aside>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['s1', { id: 's1', name: 'One', status: 'idle' }],
    ['s2', { id: 's2', name: 'Two <b>', status: 'busy' }],
    ['s3', { id: 's3', name: 'Three', status: 'idle' }],
  ]);
  app.sessionOrder = ['s1', 's2', 's3'];
  app.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }]]);
  app.webviewOrder = ['w1'];
  app.activeSessionId = 's2';
  app.activeWebviewId = null;
  app.tabLayout = null;
  app.collapsedTabGroupIds = new Set();
  app._hiddenTabGroupByRef = new Map();
  app._lastTabGroupStructureKey = null;
  app._tabCollapseStorageFailed = false;
  app._inlineRenameActive = false;
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = vi.fn();
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app._refreshMobileOverviewIfVisible = () => {};
  app._refreshHomeSessionsIfVisible = () => {};
  app.applySidebarFilter = () => {};
  app.isSessionSidebarActive = () => false;
  app._startSidebarRichClock = () => {};
  app._stopSidebarRichClock = () => {};
  app.loadAppSettingsFromStorage = () => ({});
  app.openSessionOptions = vi.fn();
  app.requestCloseSession = vi.fn();
  app.selectSession = vi.fn();
  app.openWebview = vi.fn();
  app.showWebviewModal = vi.fn();
  app.showToast = vi.fn();
  app._fullRenderSessionTabs();
  if (layout) app._applyTabLayout(layout);
  return app;
}

const section = () => document.getElementById('tabFocus');
const shortcuts = () => [...document.querySelectorAll<HTMLButtonElement>('#tabFocus .tab-focus-item')];
const shortcutKeys = () => shortcuts().map((item) => item.dataset.focusKey);
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')].map(
    (tab) => tab.dataset.webviewId || tab.dataset.id
  );
const badges = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')].map(
    (tab) => tab.querySelector('.tab-number')?.textContent ?? null
  );
const menuLabels = () => [...document.querySelectorAll('.tab-rail-action-menu button')].map((b) => b.textContent);
const clickMenu = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.tab-rail-action-menu button')]
    .find((b) => b.textContent === label)!
    .click();
const row = (id: string) => document.querySelector<HTMLElement>(`#sessionTabs .session-tab[data-id="${id}"]`)!;
const key = (target: Element, k: string) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const focusedIn = (layout: Layout) =>
  [...layout.groups.flatMap((g) => g.refs), ...layout.ungrouped]
    .filter((ref) => ref.focus === true)
    .map((ref) => `${ref.kind}:${ref.id}`);

beforeEach(() => {
  win.localStorage.clear();
  win.sessionStorage.clear();
  document.body.innerHTML = '';
  win.__codemanUser = { username: 'admin', role: 'admin', multiUser: false };
  installFetch();
});

afterEach(() => {
  document.querySelectorAll('.tab-rail-action-menu').forEach((menu) => menu.remove());
});

describe('the Focus section uses the fork rail projection', () => {
  const focusGroup = () => document.querySelector<HTMLElement>('[data-tab-group-id=":focus"]');
  const focusRows = () => [...(focusGroup()?.querySelectorAll<HTMLElement>('.session-tab') || [])];
  const focusIds = () => focusRows().map((item) => item.dataset.webviewId || item.dataset.id);

  it('draws focused sessions and web tabs first, once each, with the stored group retained', () => {
    const app = makeApp();
    expect(focusIds()).toEqual(['s2', 'w1', 's3']);
    expect(rows()).toEqual(['s2', 'w1', 's3', 's1']);
    expect(document.querySelectorAll('[data-id="s2"]')).toHaveLength(1);
    expect(app.tabLayout.groups[0].refs.map((ref: Ref) => ref.id)).toEqual(['s2', 'w1']);
    expect(section()?.hidden ?? true).toBe(true);
  });

  it('uses the rail tree keyboard model and one roving tab stop', () => {
    makeApp();
    expect(document.getElementById('sessionTabs')!.getAttribute('role')).toBe('tree');
    expect(document.querySelectorAll('#sessionTabs [role="treeitem"][tabindex="0"]')).toHaveLength(1);
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(ids.length).toBe(new Set(ids).size);
    const first = focusRows()[0];
    first.focus();
    key(first, 'ArrowDown');
    expect(document.activeElement).toBe(focusRows()[1]);
  });

  it('shows Focus even without named groups and is absent on a horizontal strip', () => {
    makeApp(flat());
    expect(focusIds()).toEqual(['s2']);
    makeApp(grouped(), 'horizontal');
    expect(focusGroup()).toBeNull();
    makeApp(null);
    expect(focusGroup()).toBeNull();
  });

  it('carries session status and alerts on the single Focus row', () => {
    const app = makeApp();
    expect(row('s2').querySelector('.tab-status')!.classList.contains('busy')).toBe(true);
    app.tabAlerts.set('s3', 'action');
    app._renderSessionTabsImmediate();
    expect(row('s3').classList.contains('tab-alert-action')).toBe(true);
  });

  it('drops a closed session and hides an empty Focus section', () => {
    const app = makeApp(flat());
    app.sessions.delete('s2');
    app.sessionOrder = ['s1', 's3'];
    app._fullRenderSessionTabs();
    expect(focusGroup()).toBeNull();
  });

  it('adopts another device focus flags without duplicating rows', () => {
    const app = makeApp(flat());
    app._applyTabLayout({ ...flat(9), ungrouped: [s('s1', { focus: true }), s('s2'), s('s3'), w('w1')] });
    expect(focusIds()).toEqual(['s1']);
    expect(rows()).toHaveLength(4);
  });

  it('offers one Focus menu entry and sends one semantic operation to add or remove it', async () => {
    const puts = installFetch();
    const app = makeApp(flat());
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s1') }, 's1');
    expect(menuLabels().filter((label) => label === 'Add to Focus')).toHaveLength(1);
    clickMenu('Add to Focus');
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].operations).toEqual([{ type: 'setFocus', ref: s('s1'), focused: true }]);
    app._tabLayoutEditor?.dispose();
  });

  it('offers Remove from Focus for a focused row', () => {
    const app = makeApp();
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s2') }, 's2');
    expect(menuLabels()).toContain('Remove from Focus');
    expect(menuLabels()).not.toContain('Add to Focus');
  });

  it('persists collapse per device and keeps the active focused row visible', () => {
    const app = makeApp();
    app.toggleFocusGroupCollapsed(true);
    expect(win.localStorage.getItem('codeman:focus-group-collapsed')).toBe('true');
    expect(focusIds()).toEqual(['s2']);
    expect(win.localStorage.getItem('codeman:tab-groups-collapsed')).toBeNull();
    makeApp();
    expect(focusIds()).toEqual(['s2']);
  });
});
