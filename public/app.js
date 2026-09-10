// Wiring: the SSE stream into the scene, and the side panel — a card per agent that opens into
// its conversation, with whichever bartender is driving it or, for a session nobody is
// orchestrating, with you.

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
/** The orchestrators the server elected, most-driving first. Each gets a patch of the bar. */
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
let homeHost = null;

const hostChip = (agent) => {
  // `agent.remote` is what the REPORTING server thought, and with one instance per host every
  // server thinks all of its own rooms are local. Away-ness is a fact about the viewer, so it
  // is decided here against the host this page was served from.
  const away = agent.hostName && homeHost && agent.hostName !== homeHost;
  return away
    ? `<span class="chip host" title="on another machine">🖥 ${escape(short(agent.hostName, 22))}</span>`
    : '';
};

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
 * The room, as the scene has worked it out: who is pouring behind each patch of the bar, who is
 * on the stools in front of it, and who is out at the tables. The panel asks the scene rather
 * than recomputing it, so the list and the room can never disagree about who is whose worker.
 */
let room = { bar: [], tables: [], queue: [] };
const patchOf = (id) => room.bar.find((p) => p.hubId === id || p.members.includes(id)) ?? null;
/** The bartender driving this session, or null when the session is one of yours. */
const bartenderOf = (id) => {
  const patch = patchOf(id);
  return patch && patch.hubId !== id ? patch.hubId : null;
};
const isBartender = (id) => room.bar.some((p) => p.hubId === id);

/** What this session's own bartender has exchanged with it, or null if nobody is driving it. */
const connFor = (id) => (isBartender(id) ? null : scene.connOf(id));

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
  room = scene.roomState();
  scene.fit();
  renderHeader({ tick: lastTick, error: null, hosts: null });
  renderPanel();
}

function threadFor(id) {
  const tender = bartenderOf(id);
  const isHub = isBartender(id);
  const rows = [...events.values()]
    .filter((e) => {
      if (isHub)
        return e.fromId === id && (e.kind === 'send' || e.kind === 'inbox' || isBriefing(e));
      const own = e.toId === id && (e.kind === 'waiting' || e.kind === 'spawn');
      // Nobody driving it means the other party is YOU, and a message from you is an event
      // with no sender at all — an unattributed queue entry, or a turn that simply started.
      if (!tender) {
        const yours = (e.toId === id && !e.fromId) || (e.fromId === id && !e.toId);
        return yours || own;
      }
      const between =
        (e.fromId === tender && e.toId === id) || (e.fromId === id && e.toId === tender);
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
  // An unattributed spawn's text is the workspace's NAME, not something anybody said — quoting
  // it back as the last thing you told this session would be a small lie on every card.
  const thread = threadFor(id).filter((e) => e.text && (e.kind !== 'spawn' || isBriefing(e)));
  const last = thread[thread.length - 1];
  if (!last) return '';
  const pouring = isBartender(id);
  const inbound = !pouring && last.fromId !== id;
  const other = pouring ? nameOf(last.toId) : null;
  const who = pouring
    ? `to ${escape(short(issueOf(other).key ?? other, 22))}`
    : inbound
      ? bartenderOf(id)
        ? 'bartender said'
        : 'you said'
      : 'said';
  return `<p class="last ${inbound ? 'in' : 'out'}">${escape(short(last.text, 120))}<time>${who} · ${ago(last.at)}</time></p>`;
}

function card(agent) {
  const conn = connFor(agent.id);
  const isHub = isBartender(agent.id);
  const count = conn ? conn.sends + conn.replies : 0;
  const drives = isHub ? (patchOf(agent.id)?.members.length ?? 0) : 0;
  return `
    <article class="card ${isHub ? 'hub' : ''} ${agent.id === scene.selectedId ? 'on' : ''}"
             data-id="${agent.id}" style="--c:${(STATUS[agent.status] ?? STATUS.idle).color}">
      <header>
        ${isHub ? '<span class="tag">Bartender</span>' : ''}
        <h4>${heading(agent)}</h4>
        ${count ? `<span class="count" title="messages exchanged">✉ ${count}</span>` : ''}
      </header>
      <div class="meta">
        ${statusPill(agent)}
        ${flavorChip(agent.flavor)}
        ${agent.model ? `<span class="chip">${escape(agent.model)}</span>` : ''}
        ${hostChip(agent)}
      </div>
      ${isHub && drives ? `<p class="last">pouring for ${drives} session${drives === 1 ? '' : 's'} at the bar</p>` : lastExchange(agent.id)}
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
  for (const patch of room.bar) {
    const tender = known.get(patch.hubId);
    if (tender) claimed.add(tender.id);
    const stools = patch.members
      .map((id) => known.get(id))
      .filter(Boolean)
      .sort((a, b) => (connFor(b.id)?.lastAt ?? 0) - (connFor(a.id)?.lastAt ?? 0));
    for (const agent of stools) claimed.add(agent.id);
    if (!tender && !stools.length) continue;
    const tenderName = tender
      ? (issueOf(tender.name, tender.branch).key ?? short(tender.name, 24))
      : 'nobody yet';
    blocks.push(
      `<h3>At the bar <small>${stools.length}</small></h3>` +
        `<p class="hint">Orchestrated by ${escape(tenderName)} — messages go straight over the bar.</p>` +
        (tender ? card(tender) : '') +
        stools.map(card).join(''),
    );
  }

  const mine = agents
    .filter((a) => !claimed.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  els.panel.innerHTML = `
    ${blocks.length ? blocks.join('') : '<h3>At the bar <small>0</small></h3><p class="hint">Nobody is orchestrating yet — a bartender is elected as soon as a session is seen driving two others. Until then the bar stands empty and the whole fleet is out on the floor.</p>'}
    ${section('At the tables', mine, 'Nobody is orchestrating these — they are yours, and a waiter carries out what you send them.')}`;

  for (const node of els.panel.querySelectorAll('.card')) {
    node.addEventListener('click', () => scene.select(node.dataset.id));
  }
}

function bubbleRow(e, agent) {
  const mine = !isBartender(agent.id) && e.fromId !== agent.id;
  const who = mine
    ? bartenderOf(agent.id)
      ? 'Bartender'
      : 'You'
    : (issueOf(agent.name, agent.branch).key ?? short(agent.name, 28));
  const to =
    e.toId && isBartender(agent.id)
      ? ` → ${issueOf(nameOf(e.toId)).key ?? short(nameOf(e.toId), 26)}`
      : '';
  return `
    <div class="msg ${mine ? 'from-hub' : 'from-agent'} k-${e.kind}">
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
    : `<p class="hint">Nothing exchanged yet. What the agent last said:</p>
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
      ${isBartender(id) ? '<span class="tag">Bartender</span>' : ''}
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

function renderHeader(world) {
  const count = (status) => agents.filter((a) => a.status === status).length;
  const waiting = count('waiting');
  els.live.className = `live ${world.error ? 'bad' : 'on'}`;
  // `world.error` already names the host each complaint came from — with several servers
  // reporting, "CLI error" alone would not say which machine was having the trouble.
  els.live.title = world.error
    ? world.error
    : `live · tick ${world.tick}${world.hosts ? ` · ${world.hosts}` : ''}`;
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
  // 1 the whole room, 2 the bar, 3 the tables, anything past that the street.
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

/**
 * One world drawn from several servers.
 *
 * Each host runs its own instance and reports only the machine it is on, because that is the
 * only machine it can read properly: its terminals answer in a millisecond and its agents'
 * own records — the transcripts an MCP-driven orchestrator writes and nothing else ever sees —
 * are local files. Nothing merges them server-side; a server that read its peers would be
 * describing a machine it cannot see, which is the thing this whole design is escaping.
 *
 * So the merge happens here, at the only point that talks to all of them.
 *
 * @type {Map<string, object>} source key ('' for this server) -> its latest snapshot
 */
const sources = new Map();
/** @type {Map<string, string>} source key -> why it is not reporting, if it is not */
const sourceTrouble = new Map();

/** A peer entry may carry its token in the URL; turn it into a stream address. */
function streamUrl(peer, path) {
  if (!peer) return path;
  const url = new URL(peer);
  const token = url.searchParams.get('token');
  return `${url.origin}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

const originOf = (peer) => (peer ? new URL(peer).host : 'this host');

/**
 * Fold every server's snapshot into one.
 *
 * Rooms partition cleanly — each instance reports its own host and no other — so agents are a
 * union rather than a reconciliation. Two things do need care:
 *
 *   - Event ids are per-server (`e1`, `e2`, …) and would collide across them, so each is
 *     namespaced by the source it came from before going anywhere near the shared map.
 *   - A link is only ever observed by the SENDER's server, which is the instance holding that
 *     orchestrator's records. A cross-host beam therefore arrives from one side only, and
 *     unioning by pair is right; if two servers somehow both claim one, the later sighting
 *     wins rather than the two being added together into a doubled count.
 */
function merged() {
  const agentsById = new Map();
  const hubs = new Set();
  const linkByPair = new Map();
  const fresh = [];
  let tick = 0;

  for (const [key, snapshot] of sources) {
    for (const agent of snapshot.agents ?? []) {
      // An instance running ON an agent's machine reports it as local, and knows more about it
      // than a fleet-scoped instance reading the same room over the cloud. Prefer that one.
      const held = agentsById.get(agent.id);
      if (!held || (held.remote && !agent.remote)) agentsById.set(agent.id, agent);
    }
    for (const id of snapshot.hubIds ?? (snapshot.hubId ? [snapshot.hubId] : [])) hubs.add(id);
    for (const link of snapshot.links ?? []) {
      const pair = `${link.fromId}|${link.toId}`;
      const held = linkByPair.get(pair);
      if (!held || (link.lastAt ?? 0) >= (held.lastAt ?? 0)) linkByPair.set(pair, link);
    }
    for (const event of snapshot.events ?? []) {
      const id = `${key}#${event.id}`;
      if (!events.has(id)) fresh.push({ ...event, id });
      events.set(id, { ...event, id });
    }
    tick = Math.max(tick, snapshot.tick ?? 0);
  }

  if (events.size > 3000) {
    for (const key of [...events.keys()].slice(0, events.size - 3000)) events.delete(key);
  }

  const trouble = [];
  for (const [key, snapshot] of sources) {
    const where = originOf(key);
    if (snapshot.error) trouble.push(`${where}: ${snapshot.error}`);
    if (snapshot.logError) trouble.push(`${where} fleet log: ${snapshot.logError}`);
    if (snapshot.transcriptError) trouble.push(`${where} transcripts: ${snapshot.transcriptError}`);
  }
  for (const [key, why] of sourceTrouble) trouble.push(`${originOf(key)}: ${why}`);

  return {
    tick,
    agents: [...agentsById.values()],
    hubIds: [...hubs],
    links: [...linkByPair.values()],
    fresh,
    error: trouble.length ? trouble.join(' · ') : null,
    hosts: `${sources.size}/${sources.size + sourceTrouble.size} hosts`,
  };
}

function redraw() {
  const world = merged();
  allAgents = world.agents;
  hubIds = world.hubIds;
  links = world.links;
  renderProjects();
  applyFilter();
  scene.setWorld(agents, hubIds, links);
  room = scene.roomState();
  // The stream replays its backlog on connect so threads have history; animating all of
  // it would fire a minute of traffic at once, so only live ticks reach the scene.
  if (!firstSnapshot) scene.addEvents(world.fresh.filter((e) => !e.replay));
  firstSnapshot = false;
  lastTick = world.tick;
  renderHeader(world);
  renderPanel();
}

function listen(peer) {
  const key = peer ?? '';
  const source = new EventSource(streamUrl(peer, '/api/stream'));
  source.onmessage = (message) => {
    sourceTrouble.delete(key);
    const snapshot = JSON.parse(message.data);
    // The server this page came from is home; every other host's rooms are away.
    if (!peer && snapshot.hostName) homeHost = snapshot.hostName;
    sources.set(key, snapshot);
    redraw();
  };
  source.onerror = () => {
    // A host that has gone away must not take its rooms with it silently: the snapshot is
    // dropped so the world stops claiming to know, and the reason is said out loud.
    sources.delete(key);
    sourceTrouble.set(key, 'not reachable — reconnecting');
    redraw();
  };
}

async function connect() {
  listen(null);
  try {
    const res = await fetch('/api/peers');
    const { peers } = await res.json();
    for (const peer of peers ?? []) listen(peer);
  } catch {
    // No peer list is the normal single-host case, not a failure.
  }
}

renderPanel();
connect();
