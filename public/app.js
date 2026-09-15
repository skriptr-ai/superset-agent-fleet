// Wiring: the SSE stream into the scene, and the side panel — a card per agent that opens into
// its conversation, with whichever bartender is driving it or, for a session nobody is
// orchestrating, with you.

import { Scene, isBriefing } from './scene.js';
import {
  STATUS,
  FLAVOR,
  PHASE_COLOR,
  issueOf,
  plainActivity,
  taskTitle,
  turnStory,
} from './draw.js';
import { DEFAULT_PLACE } from './daylight.js';
import { patchHTML } from './dom.js';
import { connectionState, validSnapshot } from './ui-state.js';

const scene = new Scene(document.getElementById('world'));
const demo = window.fleetDemo;
if (demo) scene.clock = demo.clock;
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
  clock: document.getElementById('clock'),
  clockTime: document.getElementById('clock-time'),
  clockPlace: document.getElementById('clock-place'),
  clockWeather: document.getElementById('clock-weather'),
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
/** The ones a person pinned there by hand, on the server this page came from. */
let pins = new Set();
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
let currentWorld = { tick: 0, error: null, state: 'connecting', hosts: null };
let panelAgentId = null;
const pendingPins = new Set();
const pinErrors = new Map();
const openedTerminals = new WeakSet();

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
  const away = agent.hostName && (cloudMode || (homeHost && agent.hostName !== homeHost));
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
let room = { rooms: [], bar: [], tables: [], queue: [] };
/** The developers with a restaurant on the street, [{key, name}], as the sources last said. */
let owners = [];
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
    `<button type="button" data-project="${escape(value)}" aria-pressed="${projectFilter === value}" class="${projectFilter === value ? 'on' : ''}">${escape(label)}<small>${n}</small></button>`;
  const html = [
    pill('', 'All sessions', allAgents.length),
    ...names.map((n) => pill(n, n === NO_PROJECT ? 'No project' : n, counts.get(n))),
  ].join('');
  patchHTML(els.projects, html);
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
  updateScene();
  scene.select(null);
  scene.fit();
  renderHeader(currentWorld);
}

function updateScene() {
  scene.setWorld(agents, hubIds, links, owners);
  room = scene.roomState();
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
  if (agent.stale)
    return (
      '<span class="pill stale"><i></i>last seen ' + escape(agent.status ?? 'idle') + '</span>'
    );
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

// The sidebar folders the workspace is filed in — Superset's tags. An orchestrator that
// creates its workers with `--tag` files the whole run together, and the server reads that
// filing as a reason to seat them at one bar; showing it is how a seat can be argued with.
function folderChips(agent) {
  return (agent.tags ?? [])
    .map(
      (tag) =>
        `<span class="chip folder" title="Filed in the Superset sidebar folder “${escape(tag)}”">📁 ${escape(tag)}</span>`,
    )
    .join('');
}

// Which source answered "is it working": the agent's own lifecycle hooks, read off the host
// service, or its screen. Shown so a status that looks wrong can be argued with.
function evidenceChip(agent) {
  if (!agent.evidence) return '';
  const subs = agent.subagents
    ? ` · ${agent.subagents} sub-agent${agent.subagents === 1 ? '' : 's'}`
    : '';
  const title =
    agent.evidence === 'hooks'
      ? 'Status from the lifecycle hooks the agent posts to the host service'
      : 'Status read from the terminal screen';
  return `<span class="chip" title="${title}">per its ${agent.evidence === 'hooks' ? 'hooks' : 'screen'}${escape(subs)}</span>`;
}

const ago = (at) => {
  if (!at) return 'earlier';
  const s = Math.max(0, Math.round(((demo?.at ?? Date.now()) - at) / 1000));
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

/**
 * The task, as one line under the name — see taskTitle for which line — with where it came
 * from on the hover, so a title that reads wrong can be argued with.
 */
function taskLine(agent) {
  const text = taskTitle(agent);
  if (!text) return '';
  const task = agent.task;
  const why =
    task.source === 'session'
      ? "The session's own title for itself"
      : task.source === 'task'
        ? `Superset task${task.slug ? ` ${task.slug}` : ''}`
        : 'The prompt it is acting on';
  return `<p class="task" title="${escape(why)}">${escape(short(text, 140))}</p>`;
}

/**
 * What the agent is doing about it right now — the phase and the thing it is on — while it
 * works; and once it stops, what it last said, which is the outcome. The thread header also
 * gets the phases the turn went through; a card does not, because a list of them is a wall.
 */
function nowLine(agent, { story: withStory = false } = {}) {
  if (agent.stale)
    return `<p class="now stale" title="${escape(agent.readError ?? 'Waiting for a fresh update')}">Updates paused${agent.observedAt ? ` · last seen ${ago(agent.observedAt)}` : ''}</p>`;
  const doing = agent.doing;
  if (agent.status === 'working' && doing) {
    const color = PHASE_COLOR[doing.phase] ?? PHASE_COLOR.thinking;
    // `researched → implemented → testing`: the story so far, ending on now.
    const story = withStory && doing.story?.length ? [...doing.story, doing.label].join(' → ') : '';
    const head =
      doing.phase === 'thinking'
        ? agent.says
          ? escape(short(agent.says, 120))
          : 'thinking'
        : `${escape(doing.label)}${doing.detail ? ` <code>${escape(doing.detail)}</code>` : ''}`;
    const how = doing.source === 'transcript' ? 'from its transcript' : 'read off its screen';
    return `<p class="now" style="--p:${color}" title="${how}"><i></i>${head}${story ? `<small>${escape(story)}</small>` : ''}</p>`;
  }
  const said = lastExchange(agent.id);
  const did = withStory ? turnStory(doing) : '';
  return `${said}${did ? `<p class="did">last turn: ${escape(did)}</p>` : ''}`;
}

function card(agent) {
  const conn = connFor(agent.id);
  const isHub = isBartender(agent.id);
  const count = conn ? conn.sends + conn.replies : 0;
  const drives = isHub ? (patchOf(agent.id)?.members.length ?? 0) : 0;
  return `
    <article class="card ${isHub ? 'hub' : ''} ${agent.id === scene.selectedId ? 'on' : ''}"
             data-id="${escape(agent.id)}" role="button" tabindex="0" aria-label="Open conversation with ${escape(agent.name)}" style="--c:${(STATUS[agent.status] ?? STATUS.idle).color}">
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
      ${taskLine(agent)}
      ${isHub && drives ? `<p class="last">pouring for ${drives} session${drives === 1 ? '' : 's'} at the bar</p>` : ''}
      ${nowLine(agent)}
    </article>`;
}

/**
 * The list, in the same three places as the room, so the panel never says something the
 * picture contradicts. A resting session is in the line at the door whoever its bartender
 * is: it keeps its stool, but it is not sitting on it, and the panel used to list it "at the
 * tables" — a place it had never been.
 */
function renderList() {
  const known = byId();
  const section = (title, list, note) =>
    list.length
      ? `<h3>${title} <small>${list.length}</small></h3>${note ? `<p class="hint">${note}</p>` : ''}${list.map(card).join('')}`
      : '';

  const visible = new Set(agents.map((a) => a.id));
  const houses = [];
  for (const house of room.rooms) {
    const inLine = new Set(house.queue);
    const claimed = new Set();
    const blocks = [];
    for (const patch of house.bar) {
      const tender = known.get(patch.hubId);
      if (tender) claimed.add(tender.id);
      const stools = patch.members
        .filter((id) => !inLine.has(id))
        .map((id) => known.get(id))
        .filter(Boolean)
        .sort((a, b) => (connFor(b.id)?.lastAt ?? 0) - (connFor(a.id)?.lastAt ?? 0));
      for (const agent of stools) claimed.add(agent.id);
      if (!tender && !stools.length) continue;
      const tenderName = tender
        ? (issueOf(tender.name, tender.branch).key ?? short(tender.name, 24))
        : 'nobody yet';
      // The folder this crew shares, if the bartender filed its workers with it.
      const folder = (tender?.tags ?? []).find((tag) =>
        stools.some((agent) => (agent.tags ?? []).includes(tag)),
      );
      blocks.push(
        `<h3>At the bar <small>${stools.length}</small></h3>` +
          `<p class="hint">Orchestrated by ${escape(tenderName)}${folder ? ` · folder 📁 ${escape(folder)}` : ''} — messages go straight over the bar.</p>` +
          (tender ? card(tender) : '') +
          stools.map(card).join(''),
      );
    }

    const here = house.agents.filter((id) => visible.has(id));
    const dining = here
      .filter((id) => !claimed.has(id) && !inLine.has(id))
      .map((id) => known.get(id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    // In the order they joined the line, which is the order the room draws them in.
    const line = house.queue
      .map((id) => known.get(id))
      .filter((a) => a && visible.has(a.id) && !claimed.has(a.id));

    // With a project filter on, a restaurant with none of that project in it is left out.
    if (projectFilter && !here.length) continue;
    houses.push(
      `<h2 class="house">${escape(house.name)} <small>${here.length}</small></h2>` +
        (blocks.length
          ? blocks.join('')
          : '<h3>At the bar <small>0</small></h3><p class="hint">Nobody is orchestrating here yet — a bartender is elected as soon as a session is seen driving two others.</p>') +
        section(
          'At the tables',
          dining,
          `Working, and nobody is orchestrating them — they are ${escape(house.name)}'s, and a waiter carries out what they send.`,
        ) +
        section(
          'In line at the door',
          line,
          'Resting. Behind the rope until somebody gives them a turn; a worker goes back to its stool, anyone else to a table.',
        ),
    );
  }

  patchHTML(
    els.panel,
    houses.length
      ? houses.join('')
      : '<p class="hint">Your restaurant is ready. Start an agent in a Superset workspace and it will appear here.</p>',
  );
  panelAgentId = null;
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
    <div data-key="${escape(e.id)}" class="msg ${mine ? 'from-hub' : 'from-agent'} k-${escape(e.kind)}">
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
      html.push(
        `<div data-key="${escape(e.id)}" class="sys waiting">waiting on you<time>${clock(e.at)}</time></div>`,
      );
    } else if (isBriefing(e)) {
      html.push(bubbleRow(e, agent));
    } else if (e.kind === 'spawn') {
      html.push(
        `<div data-key="${escape(e.id)}" class="sys">joined the fleet<time>${clock(e.at)}</time></div>`,
      );
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
  const changedAgent = panelAgentId !== id;
  const stick =
    changedAgent || !thread || thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
  const terminal = els.panel.querySelector('pre');
  const terminalVisible = els.panel.querySelector('details.terminal')?.open;
  const followTerminal =
    changedAgent ||
    !terminal ||
    (terminalVisible && terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 40);

  patchHTML(
    els.panel,
    `
    <button data-key="back" class="back" type="button">← all agents</button>
    <div data-key="head-${escape(id)}" class="agent-head" style="--c:${(STATUS[agent.status] ?? STATUS.idle).color}">
      ${isBartender(id) ? `<span class="tag">Bartender${pins.has(id) ? ' · pinned' : ''}</span>` : ''}
      <h2>${heading(agent)}</h2>
      <div class="meta">
        ${statusPill(agent)}
        ${flavorChip(agent.flavor)}
        ${agent.model ? `<span class="chip">${escape(agent.model)}</span>` : ''}
        ${hostChip(agent)}
        ${agent.branch ? `<span class="chip mono">⎇ ${escape(short(agent.branch, 34))}</span>` : ''}
        ${folderChips(agent)}
        ${evidenceChip(agent)}
      </div>
      ${taskLine(agent)}
      ${nowLine(agent, { story: true })}
      ${agent.queued.length ? `<p class="unread">✉ ${agent.queued.length} unread — will be read after the current tool call</p>` : ''}
      ${pinButton(id)}
    </div>
    <div data-key="thread-${escape(id)}" class="thread" tabindex="0" aria-label="Conversation history">${renderThread(agent)}</div>
    <details data-key="terminal-${escape(id)}" class="terminal" ${terminalOpen ? 'open' : ''}>
      <summary>${agent.stale ? 'Last terminal snapshot' : 'Live terminal'} <small>${escape(short(agent.worktreePath ?? '', 60))}</small></summary>
      <pre>${escape(lead?.screen ?? '')}</pre>
    </details>`,
  );
  const pre = els.panel.querySelector('pre');
  if (pre && terminalOpen && followTerminal) {
    pre.scrollTop = pre.scrollHeight;
    openedTerminals.add(pre);
  }
  const next = els.panel.querySelector('.thread');
  if (stick) next.scrollTop = next.scrollHeight;
  panelAgentId = id;
}

/**
 * The one control in the drawer that changes the world rather than describing it.
 *
 * Election is from evidence, and evidence can be missing — an orchestrator that drives one
 * worker at a time never reaches the fanout the server asks for. So a person can say so. A
 * session the server elected on its own has nothing to pin: the button then offers to pin it
 * anyway, which is what keeps it behind the bar once its commands scroll off.
 */
function pinButton(id) {
  const pinned = pins.has(id);
  const elected = isBartender(id) && !pinned;
  const label = pinned
    ? 'Unpin from the bar'
    : elected
      ? 'Pin behind the bar'
      : 'Make this the orchestrator';
  const why = pinned
    ? 'Elected from evidence again, or back at a table if there is none.'
    : elected
      ? 'Stays behind the bar even when its commands are no longer on screen.'
      : 'Puts this session behind the bar as a bartender, whatever the screens show.';
  return `<button data-key="pin" class="pin ${pinned ? 'on' : ''}" type="button" ${pendingPins.has(id) ? 'disabled' : ''} title="${escape(why)}">${pinned ? '📌 ' : ''}${label}</button>${pinErrors.has(id) ? `<p class="pin-error" role="alert">Could not save: ${escape(pinErrors.get(id))}</p>` : ''}`;
}

/** Tell the home server; the answering snapshot redraws the room. */
async function setPinned(id, pinned) {
  const res = await fetch(demo?.team ? '/api/hub?team=1' : '/api/hub', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, pinned }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (demo?.paused) {
    const result = await res.json();
    const snapshot = sources.get('');
    if (snapshot) {
      sources.set('', { ...snapshot, pins: result.pins, hubIds: result.hubIds, events: [] });
      redraw();
    }
  }
}

function renderPanel() {
  if (!drawerOpen()) return;
  if (scene.selectedId) {
    renderAgent(scene.selectedId);
    els.drawerTitle.textContent = 'Thread';
  } else {
    renderList();
    els.drawerTitle.textContent = 'Agents';
  }
}

function renderHeader(world) {
  const count = (status) => agents.filter((a) => !a.stale && a.status === status).length;
  const staleCount = agents.filter((a) => a.stale).length;
  const waiting = count('waiting');
  const state = world.state ?? 'connecting';
  const warning = ['partial', 'stale'].includes(state);
  els.live.className = `live ${state === 'unavailable' ? 'bad' : warning ? 'warning' : state === 'connecting' ? '' : 'on'}`;
  els.live.setAttribute('aria-label', `Connection: ${state}`);
  document.body.dataset.connection = state;
  // `world.error` already names the host each complaint came from — with several servers
  // reporting, "CLI error" alone would not say which machine was having the trouble.
  els.live.title = world.error
    ? world.error
    : `live · tick ${world.tick}${world.hosts ? ` · ${world.hosts}` : ''}`;
  // The handle doubles as the status line: how many, how many busy, and whether anyone needs you.
  els.handleText.innerHTML = `<b>${agents.length}</b> agents · ${count('working')} working${
    waiting ? ` · <span class="warn">${waiting} waiting on you</span>` : ''
  }${staleCount ? ` · <span class="warn">${staleCount} awaiting updates</span>` : ''}`;
  const notice = document.getElementById('connection-notice');
  notice.hidden = state === 'live';
  notice.classList.toggle('partial', warning);
  const help = cloudMode
    ? 'The connection will retry automatically.'
    : 'Keep Superset open. Run <code>bun run doctor</code> in the project folder to check your connection.';
  const messages = {
    connecting: '<strong>Opening your restaurant…</strong><p>Connecting to Superset.</p>',
    empty:
      '<strong>Your restaurant is ready.</strong><p>Start an agent in a Superset workspace and it will appear here.</p>',
    partial:
      '<strong>Some updates are unavailable.</strong><p>Connected agents are still shown. We will keep trying.</p>',
    stale:
      '<strong>Reconnecting. Showing the last update.</strong><p>Agent activity may have changed.</p>',
    unavailable: `<strong>We cannot read your agents right now.</strong><p>${help}</p>`,
  };
  patchHTML(notice, messages[state] ?? '');
  notice.title = world.error ?? '';
}

function openDrawer(open) {
  document.body.classList.toggle('drawer-open', open);
  els.handle.setAttribute('aria-expanded', String(open));
  els.drawer.setAttribute('aria-hidden', String(!open));
  els.drawer.inert = !open;
  if (open) renderPanel();
  else if (els.drawer.contains(document.activeElement)) els.handle.focus();
}
const drawerOpen = () => document.body.classList.contains('drawer-open');

// Picking someone in the room opens the drawer on their thread.
scene.onSelect = (id) => {
  if (id) openDrawer(true);
  else renderPanel();
};

let showReads = true;
els.projects.addEventListener('click', (event) => {
  const button = event.target.closest('[data-project]');
  if (button) setFilter(button.dataset.project);
});
function returnToList() {
  const id = scene.selectedId;
  scene.select(null);
  [...els.panel.querySelectorAll('.card')]
    .find((node) => node.dataset.id === id)
    ?.focus({ preventScroll: true });
}
els.panel.addEventListener('click', async (event) => {
  const card = event.target.closest('.card');
  if (card) {
    scene.select(card.dataset.id);
    els.panel.querySelector('.back')?.focus({ preventScroll: true });
  }
  if (event.target.closest('.back')) {
    returnToList();
  }
  const pin = event.target.closest('.pin');
  if (pin && scene.selectedId && !pendingPins.has(scene.selectedId)) {
    const id = scene.selectedId;
    pendingPins.add(id);
    pinErrors.delete(id);
    pin.disabled = true;
    renderPanel();
    try {
      await setPinned(id, !pins.has(id));
    } catch (err) {
      pinErrors.set(id, err.message);
    } finally {
      pendingPins.delete(id);
      pin.disabled = false;
      renderPanel();
    }
  }
});
els.panel.addEventListener('keydown', (event) => {
  const card = event.target.closest('.card');
  if (card && ['Enter', ' '].includes(event.key)) {
    event.preventDefault();
    card.click();
  }
});
els.panel.addEventListener(
  'toggle',
  (event) => {
    if (event.target.matches('details.terminal')) {
      terminalOpen = event.target.open;
      const pre = event.target.querySelector('pre');
      if (terminalOpen && pre && !openedTerminals.has(pre)) {
        pre.scrollTop = pre.scrollHeight;
        openedTerminals.add(pre);
      }
    }
  },
  true,
);
els.handle.addEventListener('click', () => openDrawer(!drawerOpen()));
els.close.addEventListener('click', () => openDrawer(false));
window.addEventListener('keydown', (e) => {
  if (
    e.target.matches('input, select, textarea') ||
    e.target.isContentEditable ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  )
    return;
  if (e.key === 'Escape') {
    if (scene.selectedId) returnToList();
    else openDrawer(false);
  }
  if (e.key === 'f' || e.key === 'F') scene.fit();
  // 1 … 9: the n-th restaurant along the street.
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
const staleSources = new Set();

/** A peer entry may carry its token in the URL; turn it into a stream address. */
function streamUrl(peer, path) {
  if (!peer) return demo?.team ? `${path}?team=1` : path;
  const url = new URL(peer);
  const token = url.searchParams.get('token');
  return `${url.origin}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

const originOf = (key) => {
  if (!key) return cloudMode ? 'the cloud' : 'this host';
  // A cloud stream keys its sources by machine name; a peer is a URL.
  return /^https?:/.test(key) ? new URL(key).host : key;
};

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
  const ownerNames = new Map();
  let tick = 0;

  for (const [key, snapshot] of sources) {
    // Whose restaurant this source's sessions fill: the developer the cloud names, else the
    // machine itself. A source with nobody on it still keeps its developer's room standing.
    const owner = snapshot.owner || snapshot.hostName || '';
    if (owner) ownerNames.set(owner, owner);
    for (const raw of snapshot.agents ?? []) {
      const agent = {
        ...raw,
        stale: raw.stale || staleSources.has(key),
        owner: raw.owner ?? owner,
      };
      // An instance running ON an agent's machine reports it as local, and knows more about it
      // than a fleet-scoped instance reading the same room over the cloud. Prefer that one.
      const held = agentsById.get(agent.id);
      if (
        !held ||
        (held.stale && !agent.stale) ||
        (Boolean(held.stale) === Boolean(agent.stale) && held.remote && !agent.remote)
      )
        agentsById.set(agent.id, agent);
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
    owners: [...ownerNames.keys()].sort().map((name) => ({ key: name, name })),
    hubIds: [...hubs],
    links: [...linkByPair.values()],
    fresh,
    error: trouble.length ? trouble.join(' · ') : null,
    state: connectionState({
      count: agentsById.size,
      errors: trouble.length > 0,
      reconnecting: staleSources.size > 0 || [...agentsById.values()].some((agent) => agent.stale),
      healthy: [...agentsById.values()].some((agent) => !agent.stale)
        ? 1
        : [...sources].filter(
            ([key, snapshot]) =>
              !staleSources.has(key) && !snapshot.error && !snapshot.agents?.length,
          ).length,
      received: sources.size > 0 || !firstSnapshot,
    }),
    hosts: `${[...sources.keys()].filter((key) => !staleSources.has(key)).length} hosts connected`,
  };
}

function redraw() {
  const world = merged();
  currentWorld = world;
  allAgents = world.agents;
  owners = world.owners;
  hubIds = world.hubIds;
  // Pins are the home server's alone: that is the one the button posts to. In the cloud they
  // are the cloud's, and every machine's snapshot carries the same set.
  pins = new Set(
    cloudMode ? [...sources.values()].flatMap((s) => s.pins ?? []) : (sources.get('')?.pins ?? []),
  );
  links = world.links;
  renderProjects();
  applyFilter();
  updateScene();
  // The stream replays its backlog on connect so threads have history; animating all of
  // it would fire a minute of traffic at once, so only live ticks reach the scene.
  if (!firstSnapshot) scene.addEvents(world.fresh.filter((e) => !e.replay));
  if (sources.size) firstSnapshot = false;
  renderHeader(world);
  renderPanel();
}

/**
 * Whether this page is the public one, fed by the cloud rather than by a server on a machine.
 * Then no host is home — every room is away and says which machine it is on — and pins are
 * the cloud's, the same on every snapshot, instead of the home server's alone.
 */
let cloudMode = false;

/** How long a stream may be silent after an error before its rooms are taken down. */
const STREAM_GRACE_MS = 8_000;

function listen(peer) {
  const streamKey = peer ?? '';
  const source = new EventSource(streamUrl(peer, '/api/stream'));
  /** The sources this stream has spoken for: one on a machine, one per machine in the cloud. */
  const spoken = new Set();
  let grace = null;
  source.onmessage = (message) => {
    if (demo?.paused && !firstSnapshot) return;
    let snapshot;
    try {
      snapshot = JSON.parse(message.data);
    } catch {
      fail('received an unreadable update');
      return;
    }
    if (!validSnapshot(snapshot)) {
      fail('received an incomplete update');
      return;
    }
    // A cloud stream carries every machine, each snapshot naming its own; a machine's stream
    // carries just that machine and names nothing.
    const key = snapshot.sourceKey ?? streamKey;
    spoken.add(key);
    clearTimeout(grace);
    grace = null;
    sourceTrouble.delete(streamKey);
    sourceTrouble.delete(key);
    staleSources.delete(key);
    staleSources.delete(streamKey);
    // The server this page came from is home; every other host's rooms are away.
    if (!peer && !cloudMode && snapshot.hostName) homeHost = snapshot.hostName;
    sources.set(key, snapshot);
    redraw();
  };
  function fail(reason) {
    // A cloud function ends its stream on a clock and the browser reconnects at once, which
    // is not a host going away; so a moment's grace before the rooms are taken down. A host
    // that is really gone must not keep its rooms silently: the snapshots are dropped so the
    // world stops claiming to know, and the reason is said out loud.
    if (grace) return;
    sourceTrouble.set(streamKey, reason);
    for (const key of spoken) staleSources.add(key);
    staleSources.add(streamKey);
    redraw();
    grace = setTimeout(() => {
      for (const key of spoken) sources.delete(key);
      sourceTrouble.set(streamKey, reason);
      redraw();
    }, STREAM_GRACE_MS);
  }
  source.onerror = () => fail('connection interrupted; reconnecting');
}

async function connect() {
  let peers = [];
  try {
    const res = await fetch('/api/peers');
    if (res.status === 401) {
      // The public page is behind a token; the door is where you give it.
      location.href = '/api/login';
      return;
    }
    const body = await res.json();
    cloudMode = body.cloud === true;
    peers = Array.isArray(body.peers) ? body.peers : [];
  } catch {
    // No peer list is the normal single-host case, not a failure.
  }
  listen(null);
  for (const peer of new Set(peers)) {
    try {
      const url = new URL(peer);
      if (typeof peer !== 'string' || !['http:', 'https:'].includes(url.protocol))
        throw new Error('invalid peer');
      listen(peer);
    } catch {
      sourceTrouble.set('peer configuration', 'an additional host has an invalid address');
      redraw();
    }
  }
}

// ── the sky: the town's clock and its weather ────────────────────────────────────────────────

/** Where the town is, as the server says; Oslo until it does. */
let place = DEFAULT_PLACE;
/** The forecast summary, or null while there is none; and why not, if the server said. */
let weather = null;
let weatherError = null;

/** How often the page asks the server for the sky. The server's own copy is what rate-limits met.no. */
const WEATHER_POLL_MS = 10 * 60_000;

/** met.no's symbol, as a glyph for the header. */
const SKY_GLYPH = {
  clearsky: ['☀', '🌙'],
  fair: ['🌤', '🌙'],
  partlycloudy: ['⛅', '☁'],
  cloudy: ['☁', '☁'],
  fog: ['🌫', '🌫'],
};
function skyGlyph(w) {
  if (!w) return '';
  if (w.thunder) return '⛈';
  if (w.kind === 'snow') return '🌨';
  if (w.kind === 'sleet') return '🌨';
  if (w.kind === 'rain') return w.intensity >= 1 ? '🌧' : '🌦';
  const pair = SKY_GLYPH[w.symbol];
  return pair ? pair[scene.light.lamps > 0.5 ? 1 : 0] : '';
}

/**
 * A sky to draw instead of the real one, from the URL — `?weather=rain`, `snow`, `sleet`,
 * `fog`, `thunder`, `cloudy`, `partly`, `clear` — so a storm can be looked at on a fine day.
 */
function pinnedWeather() {
  const want = new URLSearchParams(window.location.search).get('weather');
  if (!want) return null;
  const base = {
    symbol: 'clearsky',
    kind: null,
    intensity: 0,
    cloud: 0,
    fog: false,
    thunder: false,
  };
  const named = {
    clear: base,
    partly: { ...base, symbol: 'partlycloudy', cloud: 0.55 },
    cloudy: { ...base, symbol: 'cloudy', cloud: 1 },
    fog: { ...base, symbol: 'fog', cloud: 1, fog: true },
    rain: { ...base, symbol: 'rain', kind: 'rain', intensity: 0.7, cloud: 1 },
    heavyrain: { ...base, symbol: 'heavyrain', kind: 'rain', intensity: 1, cloud: 1 },
    sleet: { ...base, symbol: 'sleet', kind: 'sleet', intensity: 0.7, cloud: 1 },
    snow: { ...base, symbol: 'snow', kind: 'snow', intensity: 0.7, cloud: 1 },
    thunder: {
      ...base,
      symbol: 'rainandthunder',
      kind: 'rain',
      intensity: 0.8,
      cloud: 1,
      thunder: true,
    },
  };
  const w = named[want];
  return w ? { ...w, temperature: null, wind: 4, pinned: true } : null;
}

function renderClock() {
  const at = scene.skyTime();
  els.clockTime.textContent = new Intl.DateTimeFormat('en-GB', {
    timeZone: place.tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  els.clockPlace.textContent = place.name;
  const temp =
    weather && typeof weather.temperature === 'number' ? `${Math.round(weather.temperature)}°` : '';
  const glyph = skyGlyph(weather);
  els.clockWeather.textContent = [glyph, temp].filter(Boolean).join(' ');
  const full = new Intl.DateTimeFormat('en-GB', {
    timeZone: place.tz,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(at);
  const sun = `sun ${Math.round(scene.light.elevation)}° ${scene.light.elevation > 0 ? 'above' : 'below'} the horizon`;
  const sky = weather
    ? `${weather.symbol ?? 'unknown sky'}${weather.pinned ? ' (pinned by the URL)' : ` as of ${clock(Date.parse(weather.at))}`}`
    : weatherError
      ? `no forecast: ${weatherError}`
      : 'no forecast yet';
  els.clock.title = `${full}\n${sun}\n${sky}`;
}

async function fetchWeather() {
  try {
    const res = await fetch('/api/weather');
    if (!res.ok) throw new Error(`weather answered ${res.status}`);
    const body = await res.json();
    if (body.place) {
      place = body.place;
      scene.setPlace(place);
    }
    weatherError = body.error ?? null;
    // A pinned sky beats the real one; the real one is still fetched so the place is right.
    weather = pinnedWeather() ?? body.weather ?? null;
  } catch (err) {
    weatherError = err.message;
    weather = pinnedWeather();
  }
  scene.setWeather(weather);
  renderClock();
}

renderPanel();
connect();
renderClock();
setInterval(renderClock, 1000);
fetchWeather();
setInterval(fetchWeather, WEATHER_POLL_MS);
