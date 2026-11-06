/** Shared completion review state. Passive Discord reads are not observable by bots. */
(() => {
  'use strict';
  let entries = [],
    busy = false,
    timer,
    button,
    dialog,
    list,
    viewer,
    error;
  let opened,
    shownText = '',
    reading = new Set();
  const normal = (text) => text.replace(/[\s`*_#>|~]/g, '').toLowerCase();
  function visibleResponseMatches(text, lines) {
    const anchor = text
      .split('\n')
      .filter((x) => x.trim().length >= 32 && !/^\s*```/.test(x))
      .at(-1);
    return !!anchor && normal(lines).includes(normal(anchor));
  }
  function canAutoRead(a) {
    if (
      [...document.querySelectorAll('.modal, [role=dialog], dialog[open]')].some(
        (e) =>
          e.getClientRects().length &&
          getComputedStyle(e).visibility !== 'hidden' &&
          e.getAttribute('aria-hidden') !== 'true'
      )
    )
      return false;
    const id = a?.activeSessionId,
      term = a?.terminal,
      b = term?.buffer?.active;
    return (
      !!id &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      !dialog?.open &&
      !a._isLoadingBuffer &&
      !a._terminalWriteInFlight &&
      !a.terminalLoadStates?.has(id) &&
      !a._tilesOwnTerminal?.() &&
      !!b &&
      b.viewportY === b.baseY &&
      !!term.element?.getClientRects().length
    );
  }
  async function api(path, opts) {
    return window.app?._apiJson(path, opts);
  }
  async function mark(entry) {
    if (reading.has(entry.id)) return;
    reading.add(entry.id);
    try {
      const data = await api(`/api/discord/inbox/${encodeURIComponent(entry.id)}/read`, { method: 'POST' });
      if (!data) throw new Error('Could not update review state. Try again.');
      entries = entries.map((e) => (e.id === entry.id ? { ...e, reviewed: Date.now() } : e));
      render();
    } finally {
      reading.delete(entry.id);
    }
  }
  function showError(text) {
    if (error) error.textContent = text;
  }
  async function openResponse(entry) {
    showError('');
    const data = await api(`/api/discord/inbox/${encodeURIComponent(entry.id)}/response`);
    if (!data || typeof data.text !== 'string') {
      showError('Exact response unavailable. Open its Discord thread or mark it read explicitly.');
      return;
    }
    opened = entry;
    shownText = data.text;
    viewer.replaceChildren();
    const h = document.createElement('h3');
    h.textContent = entry.name;
    viewer.append(h);
    const body = document.createElement('div');
    body.className = 'rv-text';
    body.dataset.i18nSkip = '';
    if (window.app?._renderMarkdown) {
      body.innerHTML = window.app._renderMarkdown(data.text, { breaks: false });
      window.app._bindResponseViewerInteractions?.(body, entry.session);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = data.text;
      body.append(pre);
    }
    viewer.append(body);
    viewer.hidden = false;
    if (document.visibilityState === 'visible' && document.hasFocus() && dialog.open) await mark(entry);
  }
  function render() {
    if (!button) return;
    const unread = entries.filter((e) => e.reviewed === undefined);
    button.textContent = `✓ ${unread.length}`;
    button.dataset.unread = String(unread.length > 0);
    button.title = `Ready for review: ${unread.length}`;
    button.setAttribute('aria-label', button.title);
    if (!list) return;
    list.replaceChildren();
    if (!unread.length) {
      const p = document.createElement('p');
      p.textContent = 'All caught up.';
      list.append(p);
    }
    for (const entry of unread) {
      const item = document.createElement('section');
      item.className = 'completion-inbox-item';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      const time = document.createElement('time');
      time.dateTime = new Date(entry.completed).toISOString();
      time.textContent = new Date(entry.completed).toLocaleString();
      const actions = document.createElement('div');
      actions.className = 'completion-inbox-actions';
      for (const [label, run] of [
        ['Open response', () => openResponse(entry)],
        ['Mark read', () => mark(entry)],
      ]) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = async () => {
          b.disabled = true;
          try {
            await run();
          } catch (e) {
            showError(e.message);
          } finally {
            b.disabled = false;
          }
        };
        actions.append(b);
      }
      const session = document.createElement('button');
      session.textContent = 'Open session';
      session.onclick = () => {
        dialog.close();
        window.app?.selectSession?.(entry.session);
      };
      actions.append(session);
      const discord = document.createElement('a');
      discord.textContent = 'Open Discord';
      discord.href = `https://discord.com/channels/${entry.guild}/${entry.channel}${entry.message ? '/' + entry.message : ''}`;
      discord.target = '_blank';
      discord.rel = 'noopener noreferrer';
      actions.append(discord);
      item.append(name, time, actions);
      list.append(item);
    }
  }
  async function autoRead() {
    const a = window.app;
    if (!canAutoRead(a)) return;
    // Only the newest response can match the primary terminal. Older completions stay in the inbox.
    const entry = entries.find((e) => e.session === a.activeSessionId && e.reviewed === undefined);
    if (!entry) return;
    const data = await api(`/api/discord/inbox/${encodeURIComponent(entry.id)}/response`);
    if (!data?.latest || !canAutoRead(a) || a.activeSessionId !== entry.session) return;
    const b = a.terminal.buffer.active;
    let lines = '';
    const top = Math.max(0, b.viewportY),
      bottom = Math.min(b.length, top + (a.terminal.rows || 40));
    for (let i = top; i < bottom; i++) lines += (b.getLine(i)?.translateToString(true) || '') + '\n';
    if (visibleResponseMatches(data.text, lines)) await mark(entry);
  }
  async function refresh() {
    if (busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const data = await api('/api/discord/inbox');
      if (!data) {
        if (button) button.hidden = true;
        return;
      }
      if (data.enabled === false) {
        if (button) button.hidden = true;
        return;
      }
      entries = (data.entries || []).sort((a, b) => b.completed - a.completed);
      if (button) button.hidden = false;
      render();
      if (
        opened &&
        shownText &&
        dialog?.open &&
        document.hasFocus() &&
        entries.some((e) => e.id === opened.id && e.reviewed === undefined)
      )
        await mark(opened);
      else await autoRead();
    } catch {
      /* A failed read must leave the completion unread. */
    } finally {
      busy = false;
    }
  }
  function init() {
    const host = document.querySelector('.header-brand');
    if (!host) return;
    button = document.createElement('button');
    button.className = 'completion-inbox-trigger';
    button.hidden = true;
    button.type = 'button';
    host.append(button);
    dialog = document.createElement('dialog');
    dialog.className = 'completion-inbox-dialog';
    dialog.setAttribute('aria-label', 'Ready for review');
    dialog.innerHTML =
      '<div class="completion-inbox-heading"><h2>Ready for review</h2><button type="button" aria-label="Close completion inbox">Close</button></div><p class="completion-inbox-note">Shared with Discord. Reading an exact response clears that completion across both interfaces.</p><div class="completion-inbox-error" role="status"></div><div class="completion-inbox-list"></div><section class="completion-inbox-response" hidden></section>';
    document.body.append(dialog);
    list = dialog.querySelector('.completion-inbox-list');
    viewer = dialog.querySelector('.completion-inbox-response');
    error = dialog.querySelector('[role=status]');
    dialog.querySelector('button').onclick = () => dialog.close();
    dialog.addEventListener('close', () => {
      opened = undefined;
      shownText = '';
      viewer.hidden = true;
    });
    button.onclick = () => {
      dialog.showModal();
      void refresh();
    };
    const start = () => {
      if (!timer) timer = setInterval(() => void refresh(), 4000);
      void refresh();
    };
    window.addEventListener('pagehide', () => {
      clearInterval(timer);
      timer = undefined;
    });
    window.addEventListener('pageshow', start);
    document.addEventListener('visibilitychange', () => void refresh());
    window.addEventListener('focus', () => void refresh());
    start();
  }
  window.CodemanCompletionInbox = { refresh, visibleResponseMatches, canAutoRead };
  document.addEventListener('DOMContentLoaded', init);
})();
