// Wiring: the SSE stream into the scene, and the side panel — a card per agent that opens
// into the conversation between the kitchen and that agent. There may be several
// orchestrators at once, so the panel is organised as one block per chef and its workers.

import { Scene } from './scene.js';
import { STATUS, FLAVOR, issueOf, plainActivity } from './draw.js';

const scene = new Scene(document.getElementById('world'));
// A console handle, so a scene can be poked at without a live orchestrator to hand.
window.fleet = { scene };

const els = {
  panel: document.getElementById('panel'),
  live: document.getElementById('live'),
  projects: document.getElementById('projects'),
  handle: document.getElementById('handle'),
  handleText: document.getElementById('handle-text'),
  drawer: document.getElementById('drawer'),
  drawerTitle: document.getElementById('drawer-title'),
  close: document.getElementById('close'),
};

// The harness marks, as tiny inline SVGs: Claude's spark on orange, Codex's ring on black.
const LOGO = {
  claude:
    '<svg class="logo" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.6" fill="#d97757"/><g stroke="#fff" stroke-width="1.5" stroke-linecap="round"><line x1="2.5" y1="6" x2="9.5" y2="6"/><line x1="6" y1="2.5" x2="6" y2="9.5"/><line x1="3.5" y1="3.5" x2="8.5" y2="8.5"/><line x1="8.5" y1="3.5" x2="3.5" y2="8.5"/></g></svg>',
  codex:
    '<svg class="logo" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.6" fill="#111"/><polygon points="6,2.4 9.1,4.2 9.1,7.8 6,9.6 2.9,7.8 2.9,4.2" fill="none" stroke="#fff" stroke-width="1.4"/><circle cx="6" cy="6" r="1" fill="#fff"/></svg>',
  unknown:
    '<svg class="logo" viewBox="0 0 12 12"><rect width="12" height="12" rx="2.6" fill="#6b7280"/><text x="6" y="9" font-size="8" font-weight="700" text-anchor="middle" fill="#fff">?</text></svg>',
};
const flavorChip = (flavor) => {
  const f = FLAVOR[flavor] ?? FLAVOR.unknown;
  return `<span class="chip" style="--c:${f.body}">${LOGO[flavor] ?? LOGO.unknown}${escape(f.label)}</span>`;
};

let allAgents = [];
let agents = [];
/** The orchestrators, in the order the server elected them; a set for the constant lookups. */
let hubIds = [];
let hubSet = new Set();
/** Project filter: '' shows every session; a project name shows only its workspaces. */
let projectFilter = '';
try {
  projectFilter = localStorage.getItem('agent-fleet.project') ?? '';
} catch {
  // Storage can be unavailable (private window); the filter just starts on "all".
}
let links = [];
let firstSnapshot = true;
let terminalOpen = false;

/** Every event this page has seen, by id. Threads are built from this, not from the server. */
const events = new Map();

const byId = () => new Map(agents.map((a) => [a.id, a]));
// Names resolve against everyone, so a thread still reads right when its other party is
// hidden by the project filter.
const nameOf = (id) => allAgents.find((a) => a.id === id)?.name ?? 'someone';

/** Ad-hoc Superset sessions carry no project; they get a bucket of their own. */
const projectOf = (agent) => (agent.type === 'session' || !agent.project ? '' : agent.project);
const NO_PROJECT = 'Sessions without a project';

const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ''));

function escape(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Replayed history has no timestamp: it was on screen when Superset Agent Fleet started, that is all.
const clock = (at) =>
  at
    ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'earlier';

/**
 * One agent's link with the kitchen: every exchange with any orchestrator, folded together and
 * tagged with the chef it belongs to. Null for an agent no orchestrator has actually served —
 * a check-in on a stranger's screen is not a working relationship (see Scene#indexLinks).
 */
function connFor(id) {
  if (!hubIds.length || hubSet.has(id)) return null;
  const served = (a, b) =>
    links.some((l) => l.fromId === a && l.toId === b && l.sends + l.replies > 0);
  const merged = { sends: 0, reads: 0, replies: 0, lastAt: 0, hubId: null };
  let seen = false;
  for (const link of links) {
    const hub = hubSet.has(link.fromId) ? link.fromId : hubSet.has(link.toId) ? link.toId : null;
    if (!hub) continue;
    const other = link.fromId === hub ? link.toId : link.fromId;
    if (other !== id) continue;
    if (!served(hub, id) && !served(id, hub)) continue;
    seen = true;
    merged.sends += link.sends;
    merged.reads += link.reads;
    merged.replies += link.replies;
    if (link.lastAt >= merged.lastAt) {
      merged.lastAt = link.lastAt;
      merged.hubId = hub;
    }
    merged.hubId ??= hub;
  }
  return seen ? merged : null;
}

/** The chef this agent is sitting for, as an agent record. */
const hubOf = (id) => allAgents.find((a) => a.id === connFor(id)?.hubId) ?? null;

/** `chef` reads fine over one kitchen; over two it has to say whose. */
function chefLabel(id) {
  if (hubIds.length <= 1) return 'Chef';
  const hub = allAgents.find((a) => a.id === id);
  if (!hub) return 'Chef';
  return `Chef ${issueOf(hub.name, hub.branch).key ?? short(hub.name, 18)}`;
}

function applyFilter() {
  agents = projectFilter
    ? allAgents.filter((a) =>
        projectFilter === NO_PROJECT ? projectOf(a) === '' : projectOf(a) === projectFilter,
      )
    : allAgents;
}

/** The filter, as a row of pills: every project seen, plus the sessions that have none. */
function renderProjects() {
  const counts = new Map();
  for (const a of allAgents) {
    const key = projectOf(a) || NO_PROJECT;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const names = [...counts.keys()].sort(
    (a, b) => (a === NO_PROJECT) - (b === NO_PROJECT) || a.localeCompare(b),
  );
  if (projectFilter && !counts.has(projectFilter)) projectFilter = '';
  const pill = (value, label, n) =>
    `<button type="button" data-project="${escape(value)}" class="${projectFilter === value ? 'on' : ''}">${escape(label)}<small>${n}</small></button>`;
  const html = [
    pill('', 'All sessions', allAgents.length),
    ...names.map((n) => pill(n, n === NO_PROJECT ? 'No project' : n, counts.get(n))),
  ].join('');
  if (els.projects.innerHTML !== html) {
    els.projects.innerHTML = html;
    for (const b of els.projects.querySelectorAll('button'))
      b.addEventListener('click', () => setFilter(b.dataset.project));
  }
}

function setFilter(value) {
  projectFilter = value;
  try {
    localStorage.setItem('agent-fleet.project', projectFilter);
  } catch {
    // Not persisted; still applied.
  }
  renderProjects();
  applyFilter();
  scene.select(null);
  scene.setWorld(agents, hubIds, links);
  scene.fit();
  renderHeader({ tick: lastTick, error: null });
  renderPanel();
}

function threadFor(id) {
  const isHub = hubSet.has(id);
  const rows = [...events.values()]
    .filter((e) => {
      // A chef's thread is everything it sent out, to anyone; a worker's is everything it
      // exchanged with the kitchen, whichever chef was at the other end of it.
      if (isHub) return e.fromId === id && (e.kind === 'send' || e.kind === 'inbox');
      const between =
        (hubSet.has(e.fromId) && e.toId === id) || (e.fromId === id && hubSet.has(e.toId));
      return between || (e.toId === id && (e.kind === 'waiting' || e.kind === 'spawn'));
    })
    .filter((e) => e.kind !== 'dispatch')
    .sort((a, b) => a.at - b.at);

  // The same message arrives twice: once from the orchestrator's screen (`send`), once from
  // the worker's queue (`inbox`). Keep whichever came first, drop the echo.
  const out = [];
  for (const e of rows) {
    if (e.kind === 'inbox' || e.kind === 'send') {
      const key = (e.text ?? '').slice(0, 48);
      const dup = out.find(
        (o) =>
          (o.kind === 'send' || o.kind === 'inbox') &&
          o.toId === e.toId &&
          (o.text ?? '').slice(0, 48) === key &&
          Math.abs(o.at - e.at) < 90_000,
      );
      if (dup) {
        // The queue copy is usually the longer one: the orchestrator's screen elides.
        if ((e.text ?? '').length > (dup.text ?? '').length) dup.text = e.text;
        continue;
      }
    }
    out.push({ ...e });
  }
  return out;
}

// Status in plain words: the agent CLIs' own chrome ("esc to interrupt", token counts) is
// for the person at that terminal, not for a room full of them.
function statusPill(agent) {
  const s = STATUS[agent.status] ?? STATUS.idle;
  const dur = agent.status === 'working' ? plainActivity(agent.activity ?? '') : '';
  const text =
    agent.status === 'working'
      ? `working${dur ? ` · ${dur}` : ''}`
      : agent.status === 'waiting'
        ? 'waiting on you'
        : agent.status === 'idle'
          ? 'idle'
          : s.label;
  return `<span class="pill" style="--c:${s.color}"><i></i>${escape(text)}</span>`;
}

const ago = (at) => {
  if (!at) return 'earlier';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 360) / 10} h ago`;
};

const heading = (agent) => {
  const issue = issueOf(agent.name, agent.branch);
  return issue.key
    ? `<span class="key">${escape(issue.key)}</span>${escape(issue.title)}`
    : escape(agent.name);
};

function lastExchange(id) {
  const thread = threadFor(id).filter((e) => e.text);
  const last = thread[thread.length - 1];
  if (!last) return '';
  const inbound = hubSet.has(last.fromId);
  const other = hubSet.has(id) ? nameOf(last.toId) : null;
  const who = hubSet.has(id)
    ? `to ${escape(short(issueOf(other).key ?? other, 22))}`
    : inbound
      ? 'chef said' // which chef, when there are two, is the 👨‍🍳 chip on the card above
      : 'said';
  return `<p class="last ${inbound ? 'in' : 'out'}">${escape(short(last.text, 120))}<time>${who} · ${ago(last.at)}</time></p>`;
}

function card(agent) {
  const conn = connFor(agent.id);
  const isHub = hubSet.has(agent.id);
  const count = conn ? conn.sends + conn.replies : 0;
  const drives = isHub ? workersOf(agent.id).length : 0;
  // With two kitchens open, a worker's card says which one it belongs to.
  const chef = !isHub && hubIds.length > 1 && conn?.hubId ? hubOf(agent.id) : null;
  return `
    <article class="card ${isHub ? 'hub' : ''} ${agent.id === scene.selectedId ? 'on' : ''}"
             data-id="${agent.id}" style="--c:${(STATUS[agent.status] ?? STATUS.idle).color}">
      <header>
        ${isHub ? '<span class="tag">Orchestrator</span>' : ''}
        <h4>${heading(agent)}</h4>
        ${count ? `<span class="count" title="messages exchanged">✉ ${count}</span>` : ''}
      </header>
      <div class="meta">
        ${statusPill(agent)}
        ${flavorChip(agent.flavor)}
        ${agent.model ? `<span class="chip">${escape(agent.model)}</span>` : ''}
        ${chef ? `<span class="chip" title="its orchestrator">👨‍🍳 ${escape(short(issueOf(chef.name, chef.branch).key ?? chef.name, 22))}</span>` : ''}
      </div>
      ${isHub && drives ? `<p class="last">driving ${drives} worker${drives === 1 ? '' : 's'}</p>` : lastExchange(agent.id)}
    </article>`;
}

/** The agents one chef has served, most recently spoken to first. */
const workersOf = (hubId) =>
  agents
    .filter((a) => !hubSet.has(a.id) && connFor(a.id)?.hubId === hubId)
    .sort((a, b) => (connFor(b.id)?.lastAt ?? 0) - (connFor(a.id)?.lastAt ?? 0));

function renderList() {
  const known = byId();
  const hubs = hubIds.map((id) => known.get(id)).filter(Boolean);
  const claimed = new Set(hubs.flatMap((hub) => workersOf(hub.id).map((a) => a.id)));
  const others = agents
    .filter((a) => !hubSet.has(a.id) && !claimed.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const section = (title, list, hint) =>
    list.length
      ? `<h3>${title} <small>${list.length}</small></h3>${list.map(card).join('')}`
      : hint
        ? `<h3>${title}</h3><p class="hint">${hint}</p>`
        : '';

  // One block per kitchen: the chef, then the tables it is serving.
  const kitchens = hubs
    .map((hub) => {
      const workers = workersOf(hub.id);
      const title =
        hubs.length > 1
          ? `Workers of ${escape(short(issueOf(hub.name, hub.branch).key ?? hub.name, 24))}`
          : 'Workers';
      return card(hub) + section(title, workers, 'Nobody has been messaged yet.');
    })
    .join('');

  els.panel.innerHTML = `
    ${kitchens || '<p class="hint">No orchestrator detected yet — one is elected as soon as a session is seen commanding two others, or two others are seen reporting to it.</p>'}
    ${section('Other sessions', others)}`;

  for (const node of els.panel.querySelectorAll('.card')) {
    node.addEventListener('click', () => scene.select(node.dataset.id));
  }
}

function bubbleRow(e, agent) {
  const fromHub = hubSet.has(e.fromId);
  const who = fromHub
    ? chefLabel(e.fromId)
    : (issueOf(agent.name, agent.branch).key ?? short(agent.name, 28));
  const to =
    e.toId && hubSet.has(agent.id)
      ? ` → ${issueOf(nameOf(e.toId)).key ?? short(nameOf(e.toId), 26)}`
      : '';
  return `
    <div class="msg ${fromHub ? 'from-hub' : 'from-agent'} k-${e.kind}">
      <div class="who">${escape(who)}${escape(to)}<time>${clock(e.at)}</time></div>
      <div class="body">${escape(e.text)}</div>
    </div>`;
}

function renderThread(agent) {
  const thread = threadFor(agent.id);
  const html = [];
  let reads = 0;
  let readAt = 0;
  const flushReads = () => {
    if (!reads) return;
    html.push(
      `<div class="sys read">orchestrator checked in${reads > 1 ? ` ×${reads}` : ''}<time>${clock(readAt)}</time></div>`,
    );
    reads = 0;
  };
  for (const e of thread) {
    if (e.kind === 'read') {
      reads += 1;
      readAt = e.at;
      continue;
    }
    flushReads();
    if (e.kind === 'waiting') {
      html.push(`<div class="sys waiting">waiting on you<time>${clock(e.at)}</time></div>`);
    } else if (e.kind === 'spawn') {
      html.push(`<div class="sys">joined the fleet<time>${clock(e.at)}</time></div>`);
    } else if (e.text) {
      html.push(bubbleRow(e, agent));
    }
  }
  flushReads();
  return html.length
    ? html.join('')
    : `<p class="hint">Nothing exchanged with the orchestrator yet. What the agent last said:</p>
       <div class="msg from-agent"><div class="body">${escape(agent.says || '—')}</div></div>`;
}

function renderAgent(id) {
  const agent = byId().get(id);
  if (!agent) {
    renderList();
    return;
  }
  const lead = agent.terminals.find((t) => t.id === agent.leadTerminalId) ?? agent.terminals[0];
  const thread = els.panel.querySelector('.thread');
  const stick = !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;

  els.panel.innerHTML = `
    <button class="back" type="button">← all agents</button>
    <div class="agent-head" style="--c:${(STATUS[agent.status] ?? STATUS.idle).color}">
      ${hubSet.has(id) ? '<span class="tag">Orchestrator</span>' : ''}
      <h2>${heading(agent)}</h2>
      <div class="meta">
        ${statusPill(agent)}
        ${flavorChip(agent.flavor)}
        ${agent.model ? `<span class="chip">${escape(agent.model)}</span>` : ''}
        ${agent.branch ? `<span class="chip mono">⎇ ${escape(short(agent.branch, 34))}</span>` : ''}
      </div>
      ${agent.queued.length ? `<p class="unread">✉ ${agent.queued.length} unread — will be read after the current tool call</p>` : ''}
    </div>
    <div class="thread">${renderThread(agent)}</div>
    <details class="terminal" ${terminalOpen ? 'open' : ''}>
      <summary>Live terminal <small>${escape(short(agent.worktreePath ?? '', 60))}</small></summary>
      <pre>${escape(lead?.screen ?? '')}</pre>
    </details>`;

  els.panel.querySelector('.back').addEventListener('click', () => scene.select(null));
  const details = els.panel.querySelector('details');
  details.addEventListener('toggle', () => {
    terminalOpen = details.open;
  });
  const pre = els.panel.querySelector('pre');
  if (pre) pre.scrollTop = pre.scrollHeight; // a terminal's interesting end is the bottom
  const next = els.panel.querySelector('.thread');
  if (stick) next.scrollTop = next.scrollHeight;
  else if (thread) next.scrollTop = thread.scrollTop;
}

function renderPanel() {
  if (scene.selectedId) {
    renderAgent(scene.selectedId);
    els.drawerTitle.textContent = 'Thread';
  } else {
    renderList();
    els.drawerTitle.textContent = 'Agents';
  }
}

function renderHeader(snapshot) {
  const count = (status) => agents.filter((a) => a.status === status).length;
  const waiting = count('waiting');
  els.live.className = `live ${snapshot.error ? 'bad' : 'on'}`;
  const trouble = [
    snapshot.error ? `CLI error: ${snapshot.error}` : '',
    // A broken fleet log is not fatal — screens still carry the world — but it is silent
    // under-reporting unless it is said out loud somewhere.
    snapshot.logError ? `fleet log: ${snapshot.logError}` : '',
  ].filter(Boolean);
  els.live.title = trouble.length ? trouble.join(' · ') : `live · tick ${snapshot.tick}`;
  // The handle doubles as the status line: how many, how many busy, and whether anyone needs you.
  els.handleText.innerHTML = `<b>${agents.length}</b> agents · ${count('working')} working${
    waiting ? ` · <span class="warn">${waiting} waiting on you</span>` : ''
  }`;
}

function openDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  els.handle.setAttribute('aria-expanded', String(open));
  els.drawer.setAttribute('aria-hidden', String(!open));
}
const drawerOpen = () => document.body.classList.contains('drawer-open');

// Picking someone in the room opens the drawer on their thread.
scene.onSelect = (id) => {
  renderPanel();
  if (id) openDrawer(true);
};

let showReads = true;
let lastTick = 0;
els.handle.addEventListener('click', () => openDrawer(!drawerOpen()));
els.close.addEventListener('click', () => openDrawer(false));
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') {
    if (scene.selectedId) scene.select(null);
    else openDrawer(false);
  }
  if (e.key === 'f' || e.key === 'F') scene.fit();
  if (e.key === 's' || e.key === 'S') openDrawer(!drawerOpen());
  if (e.key === 'r' || e.key === 'R') {
    showReads = !showReads;
    scene.showReads = showReads;
    document.body.classList.toggle('hide-reads', !showReads);
  }
  if (e.key === '+' || e.key === '=') scene.zoomBy(1.4);
  if (e.key === '-' || e.key === '_') scene.zoomBy(1 / 1.4);
});

function connect() {
  const source = new EventSource('/api/stream');
  source.onmessage = (message) => {
    const snapshot = JSON.parse(message.data);
    allAgents = snapshot.agents ?? [];
    hubIds = snapshot.hubIds ?? [];
    hubSet = new Set(hubIds);
    links = snapshot.links ?? [];
    renderProjects();
    applyFilter();
    for (const e of snapshot.events ?? []) events.set(e.id, e);
    if (events.size > 3000) {
      for (const key of [...events.keys()].slice(0, events.size - 3000)) events.delete(key);
    }
    scene.setWorld(agents, hubIds, links);
    // The stream replays its backlog on connect so threads have history; animating all of
    // it would fire a minute of traffic at once, so only live ticks reach the scene.
    if (!firstSnapshot) scene.addEvents((snapshot.events ?? []).filter((e) => !e.replay));
    firstSnapshot = false;
    lastTick = snapshot.tick;
    renderHeader(snapshot);
    renderPanel();
  };
  source.onerror = () => {
    els.live.className = 'live bad';
    els.live.title = 'reconnecting…';
  };
}

renderPanel();
connect();
