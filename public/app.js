// Wiring: the SSE stream into the scene, and the side panel — a card per agent that opens
// into the conversation between the orchestrator and that agent.

import { Scene, isBriefing } from './scene.js';
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
/**
 * The orchestrators the server elected, most-driving first. It sends a set now; the scene
 * still names two houses, so anything past the second has nowhere to sit — see Scene#electHubs.
 */
let hubIds = [];
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

/**
 * Which machine an agent is really on, shown only when that is not this one.
 *
 * A fleet on one box needs no such label, and stamping this machine's name on every card
 * would be noise on the common case. The moment a VM joins, though, `main` on `Skriptr`
 * exists twice over and the name alone stops identifying anything.
 */
const hostChip = (agent) =>
  agent.remote && agent.hostName
    ? `<span class="chip host" title="on another machine">🖥 ${escape(short(agent.hostName, 22))}</span>`
    : '';

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
 * The two restaurants, as the scene has worked them out: which session is chef where, and who
 * is sitting in each. The panel asks the scene rather than recomputing it, so the list and the
 * block can never disagree about who is whose worker.
 */
let houses = [];
const houseOfAgent = (id) => houses.find((h) => h.hubId === id || h.members.includes(id)) ?? null;
const chefOf = (id) => houseOfAgent(id)?.hubId ?? null;
const isChef = (id) => houses.some((h) => h.hubId && h.hubId === id);

/** What this session's own chef has exchanged with it, or null if nobody is driving it. */
const connFor = (id) => (isChef(id) ? null : scene.connOf(id));

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
  houses = scene.houseState();
  scene.fit();
  renderHeader({ tick: lastTick, error: null });
  renderPanel();
}

function threadFor(id) {
  const chef = chefOf(id);
  const isHub = isChef(id);
  const rows = [...events.values()]
    .filter((e) => {
      if (isHub)
        return e.fromId === id && (e.kind === 'send' || e.kind === 'inbox' || isBriefing(e));
      const own = e.toId === id && (e.kind === 'waiting' || e.kind === 'spawn');
      if (!chef) return own;
      const between = (e.fromId === chef && e.toId === id) || (e.fromId === id && e.toId === chef);
      return between || own;
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
  const mine = isChef(id);
  const inbound = !mine && last.fromId === chefOf(id);
  const other = mine ? nameOf(last.toId) : null;
  const who = mine
    ? `to ${escape(short(issueOf(other).key ?? other, 22))}`
    : inbound
      ? 'chef said'
      : 'said';
  return `<p class="last ${inbound ? 'in' : 'out'}">${escape(short(last.text, 120))}<time>${who} · ${ago(last.at)}</time></p>`;
}

function card(agent) {
  const conn = connFor(agent.id);
  const isHub = isChef(agent.id);
  const house = houseOfAgent(agent.id);
  const count = conn ? conn.sends + conn.replies : 0;
  const drives = isHub ? (house?.members.length ?? 0) : 0;
  return `
    <article class="card ${isHub ? 'hub' : ''} ${agent.id === scene.selectedId ? 'on' : ''}"
             data-id="${agent.id}" style="--c:${(STATUS[agent.status] ?? STATUS.idle).color}">
      <header>
        ${isHub ? `<span class="tag">${escape(house?.name ?? 'Orchestrator')}</span>` : ''}
        <h4>${heading(agent)}</h4>
        ${count ? `<span class="count" title="messages exchanged">✉ ${count}</span>` : ''}
      </header>
      <div class="meta">
        ${statusPill(agent)}
        ${flavorChip(agent.flavor)}
        ${agent.model ? `<span class="chip">${escape(agent.model)}</span>` : ''}
        ${hostChip(agent)}
      </div>
      ${isHub && drives ? `<p class="last">driving ${drives} session${drives === 1 ? '' : 's'} inside</p>` : lastExchange(agent.id)}
    </article>`;
}

function renderList() {
  const known = byId();
  const section = (title, list, note) =>
    list.length
      ? `<h3>${title} <small>${list.length}</small></h3>${note ? `<p class="hint">${note}</p>` : ''}${list.map(card).join('')}`
      : '';

  const claimed = new Set();
  const blocks = [];
  for (const house of houses) {
    const chef = known.get(house.hubId);
    if (chef) claimed.add(chef.id);
    const inside = house.members
      .map((id) => known.get(id))
      .filter(Boolean)
      .sort((a, b) => (connFor(b.id)?.lastAt ?? 0) - (connFor(a.id)?.lastAt ?? 0));
    for (const agent of inside) claimed.add(agent.id);
    if (!chef && !inside.length) continue;
    blocks.push(
      `<h3>${escape(house.name)} <small>${inside.length}</small></h3>` +
        (chef ? card(chef) : '') +
        inside.map(card).join(''),
    );
  }

  const street = agents
    .filter((a) => !claimed.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  els.panel.innerHTML = `
    ${blocks.length ? blocks.join('') : '<p class="hint">No orchestrator detected yet — one is elected as soon as a session is seen driving two others. Until then the restaurant is shut and everybody is out on the street.</p>'}
    ${section('Out on the street', street, 'Running on their own, eating from the carts.')}`;

  for (const node of els.panel.querySelectorAll('.card')) {
    node.addEventListener('click', () => scene.select(node.dataset.id));
  }
}

function bubbleRow(e, agent) {
  const fromHub = e.fromId === chefOf(agent.id) && !isChef(agent.id);
  const who = fromHub ? 'Chef' : (issueOf(agent.name, agent.branch).key ?? short(agent.name, 28));
  const to =
    e.toId && isChef(agent.id)
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
    } else if (isBriefing(e)) {
      html.push(bubbleRow(e, agent));
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
      ${isChef(id) ? `<span class="tag">${escape(houseOfAgent(id)?.name ?? 'Orchestrator')}</span>` : ''}
      <h2>${heading(agent)}</h2>
      <div class="meta">
        ${statusPill(agent)}
        ${flavorChip(agent.flavor)}
        ${agent.model ? `<span class="chip">${escape(agent.model)}</span>` : ''}
        ${hostChip(agent)}
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
    snapshot.transcriptError ? `transcripts: ${snapshot.transcriptError}` : '',
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
  // One digit per restaurant, in the order the orchestrators were elected; past the last one
  // the digit frames the street. On a two-kitchen block that is still 1, 2, street.
  if (e.key >= '1' && e.key <= '9') scene.fitZone(Number(e.key) - 1);
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
    // `hubId` is the pre-multi-orchestrator field; tolerate it so an older server still draws.
    hubIds = snapshot.hubIds ?? (snapshot.hubId ? [snapshot.hubId] : []);
    links = snapshot.links ?? [];
    renderProjects();
    applyFilter();
    for (const e of snapshot.events ?? []) events.set(e.id, e);
    if (events.size > 3000) {
      for (const key of [...events.keys()].slice(0, events.size - 3000)) events.delete(key);
    }
    scene.setWorld(agents, hubIds, links);
    houses = scene.houseState();
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
