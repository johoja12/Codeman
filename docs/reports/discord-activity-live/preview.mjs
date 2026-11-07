const SESSIONS = [],
  BASE_TIME = Math.floor(Date.now() / 1000);
const componentCount = (nodes) =>
  nodes.reduce(
    (n, c) => n + 1 + componentCount(c.components ?? []) + (c.accessory ? componentCount([c.accessory]) : 0),
    0
  );
const actualPayload = await (await fetch('./payload.json')).json();
let view = 'recent',
  page = 0,
  sessions = structuredClone(SESSIONS),
  offline = false,
  updated = BASE_TIME,
  simulated = false;
const root = document.querySelector('#payload');
const dialog = document.querySelector('#detail');
const esc = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function relative(timestamp) {
  const age = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  return age < 60
    ? 'just now'
    : age < 120
      ? '1 minute ago'
      : age < 3600
        ? Math.floor(age / 60) + ' minutes ago'
        : age < 7200
          ? '1 hour ago'
          : Math.floor(age / 3600) + ' hours ago';
}
const emojis = { '🟡': '1f7e1', '✅': '2705', '🔴': '1f534', '⚫': '26ab', '⚠️': '26a0' };
const withEmoji = (text) =>
  Object.entries(emojis).reduce(
    (s, [emoji, id]) => s.replaceAll(emoji, `<img class="emoji" src="emoji/${id}.svg" alt="${emoji}">`),
    text
  );
function md(input) {
  return input
    .split('\n')
    .map((line) => {
      const sub = line.startsWith('-# '),
        heading = line.startsWith('## ');
      let value = esc(line.replace(/^(?:-# |## )/, ''));
      value = value
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(
          /&lt;t:(\d+):R&gt;/g,
          (_, t) =>
            `<span class="relative" data-time="${t}" title="${new Date(Number(t) * 1000).toLocaleString()}">${relative(Number(t))}</span>`
        );
      value = value.replace(/\[([^\]\n]+)\]\((https:\/\/discord\.com\/channels\/[0-9/]+)\)/g, (raw, label, url) =>
        /:\/\/|www\./i.test(label) ? raw : `<a href="${url}">${label}</a>`
      );
      value = withEmoji(value);
      return heading ? '<h2>' + value + '</h2>' : sub ? '<small>' + value + '</small>' : '<p>' + value + '</p>';
    })
    .join('');
}
function component(c) {
  if (c.type === 10) {
    const d = document.createElement('div');
    d.className = 'textdisplay';
    d.innerHTML = md(c.content);
    return d;
  }
  if (c.type === 17) {
    const d = document.createElement('section');
    d.className = 'container' + (c.accent_color != null ? ' accent' : '');
    if (c.accent_color != null) d.style.setProperty('--accent', '#' + c.accent_color.toString(16).padStart(6, '0'));
    c.components.forEach((x) => d.append(component(x)));
    return d;
  }
  if (c.type === 14) {
    const d = document.createElement('hr');
    d.className = 'separator';
    return d;
  }
  if (c.type === 9) {
    const d = document.createElement('div');
    d.className = 'section';
    c.components.forEach((x) => d.append(component(x)));
    d.append(component(c.accessory));
    return d;
  }
  if (c.type === 1) {
    const d = document.createElement('div');
    d.className = 'actionrow';
    c.components.forEach((x) => d.append(component(x)));
    return d;
  }
  if (c.type === 3) {
    const w = document.createElement('div');
    w.className = 'selectwrap';
    const d = document.createElement('select');
    d.className = 'native-select';
    d.id = 'activity-view';
    d.setAttribute('aria-label', 'Activity view');
    for (const o of c.options) {
      const option = document.createElement('option');
      option.value = o.value;
      option.textContent = o.label + ' — ' + o.description;
      option.selected = o.default;
      d.append(option);
    }
    d.onchange = () => {
      view = d.value;
      page = 0;
      render();
    };
    w.append(d);
    return w;
  }
  if (c.type === 2) {
    const d = document.createElement('button');
    d.className = 'nativebutton' + (c.style === 1 ? ' primary' : c.style === 5 ? ' link' : '');
    d.textContent = c.label;
    d.disabled = !!c.disabled;
    d.onclick = () => handle(c);
    return d;
  }
  throw Error('Unsupported mock component ' + c.type);
}
function handle(c) {
  show(
    'Implementation preview',
    '<p>This is the actual implementation payload, rendered locally. Filters, navigation and guarded actions are tested through the native UI suite; this preview does not connect to Discord.</p>'
  );
  return;

  const id = c.custom_id?.replace('mock:', '');
  if (id === 'prev') {
    page--;
    render();
  } else if (id === 'next') {
    page++;
    render();
  } else if (id === 'refresh') {
    if (offline) {
      notify('Connection interrupted · showing last known activity');
      return;
    }
    updated = Math.floor(Date.now() / 1000);
    render();
    notify('Activity refreshed · no new Discord message');
  } else if (id === 'new') {
    show(
      'New session',
      '<p>This opens the existing native case and CLI picker in Discord. The preview does not start an agent.</p>'
    );
  } else if (c.url?.includes('example.invalid')) {
    show(
      'Open Codeman',
      '<p>This button opens the Codeman web interface. Production will use your configured web address.</p>'
    );
  } else {
    let s = id?.startsWith('open:')
      ? sessions.find((s) => s.id === id.slice(5))
      : SESSIONS[Number(BigInt(c.url.split('/').at(-1)) - 555555555555555555n)];
    show(
      s?.state === 'attention' ? 'Needs your answer' : 'Jump to the conversation',
      `<p><strong>${esc(s?.name ?? 'Session')}</strong></p><p>${esc(s?.summary ?? '')}</p><p>${s?.state === 'attention' ? 'Production opens the current question or approval in a private Discord panel. Clicking Review does not approve anything.' : 'Production opens the exact final response or session thread in Discord.'}</p><p>This is a sample destination. No live session is modified.</p>`
    );
  }
}
function render() {
  const payload = actualPayload;
  root.replaceChildren(...payload.components.map(component));
  root.dataset.componentCount = componentCount(payload.components);
  window.activityPayload = payload;
  document.querySelector('#scenario').textContent = 'Connection: ' + (offline ? 'offline' : 'live');
  document.querySelectorAll('.thread')[0].innerHTML = withEmoji('└ ⚫ Idle · w4-Codeman');
  document.querySelectorAll('.thread')[1].innerHTML = withEmoji(
    simulated ? '└ ⚫ Idle · w1-Plex' : '└ 🟡 Working · w1-Plex'
  );
}
function notify(text) {
  const t = document.querySelector('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function show(title, body) {
  document.querySelector('#detailbody').innerHTML = '<h2>' + esc(title) + '</h2>' + body;
  dialog.showModal();
}
document.querySelector('#simulate').onclick = () => {
  offline = false;
  simulated = !simulated;
  sessions = structuredClone(SESSIONS);
  if (simulated) {
    const s = sessions.find((s) => s.id === 'plex');
    Object.assign(s, {
      state: 'finished',
      age: BASE_TIME - Math.floor(Date.now() / 1000),
      event: 'Turn finished',
      summary: 'Preview generation verified. Ready for your next task.',
    });
  }
  updated = Math.floor(Date.now() / 1000);
  view = 'recent';
  page = 0;
  render();
  notify(simulated ? 'w1-Plex finished · moved to the top silently' : 'Sample activity reset');
};
document.querySelector('#scenario').onclick = () => {
  offline = !offline;
  render();
};
document.querySelector('#inspect').onclick = () =>
  show(
    'Designed for real Discord',
    `<p>A Components V2 preview built from the same <a href="payload.json" target="_blank">sample message payload</a> used to render this page. The current view uses <strong>${componentCount(window.activityPayload.components)} / 40 components</strong>.</p><ul><li>Native containers, sections, separators and row actions.</li><li>Recent is the default. Filters and pagination work here.</li><li>Updates edit one owned message silently; no read tracking.</li><li>Finished requires native completion evidence.</li><li>Desktop and mobile use the same message payload.</li></ul><p>Discord owns final font sizes, spacing, width and rendering. This browser preview approximates its client.</p><p>Patterns researched: <a href="https://www.tickets.tools/docs/ticketing/multi-panels/">Tickets premium panels</a>, <a href="https://botghost.com/whats-new/builder-update">BotGhost’s V2 builder</a>, and <a href="https://assistance.sh/docs/features/templates/v2">Assistance V2 templates</a>.</p>`
  );
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
setInterval(() => {
  document.querySelectorAll('[data-time]').forEach((e) => (e.textContent = relative(Number(e.dataset.time))));
}, 15000);
render();

document.querySelectorAll('.thread').forEach((e) => (e.innerHTML = withEmoji(e.textContent)));
