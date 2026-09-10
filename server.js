#!/usr/bin/env bun
// Superset Agent Fleet — serves the world at http://localhost:4400 and pushes each poll over SSE.
//
// The port is fixed and deliberately outside the per-slot dev ranges (see
// .claude/rules/dev-stack.md): every worktree's stack is a different stack, but there is only
// one fleet, so a second Superset Agent Fleet would draw the same world twice on two ports. Starting one
// while another is up therefore reports the running URL and exits 0 — the orchestrator can call
// `start` unconditionally at the top of a run without guarding it.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from './lib/world.js';
import { cliVersion, transportNote, useDirect } from './lib/superset.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

const PORT = Number(process.env.AGENT_FLEET_PORT ?? 4400);
const POLL_MS = Number(process.env.AGENT_FLEET_POLL_MS ?? 2500);

/**
 * Which interface to listen on. Loopback unless told otherwise, which is a TIGHTENING: Bun
 * serves on 0.0.0.0 when not told, so until now this was reachable on every interface the
 * machine had — a reader of every terminal screen on the box, offered to the whole network by
 * default. One instance per host means deliberately publishing some of them, and a default
 * that was already open is the wrong place to start from.
 *
 * Set it to the address you mean, never `0.0.0.0`: on a host whose firewall is inactive that
 * also serves the fleet on its public IP.
 */
const BIND = process.env.AGENT_FLEET_BIND ?? '127.0.0.1';

/** Required on every /api route once set. EventSource cannot send headers, so `?token=` counts. */
const TOKEN = process.env.AGENT_FLEET_TOKEN ?? '';

/**
 * Other hosts' instances, comma-separated (`http://preben-dev-vm:4400?token=…`). The browser
 * merges them with this one; nothing server-side ever calls them, because a server that read
 * its peers would be back to describing a machine it cannot see.
 */
const PEERS = (process.env.AGENT_FLEET_PEERS ?? '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

const isLoopback = (host) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

/**
 * `fleet` reads every host it can see, which is what a single instance has always done and is
 * still right when there is only one. `host` reads only the machine it runs on, which is what
 * an instance does once its peers are covering the others — and is the whole point: reading
 * your own machine is a millisecond and gives you the local files too.
 */
const SCOPE = process.env.AGENT_FLEET_SCOPE === 'host' ? 'host' : 'fleet';

/** Peers are printed at startup and a token in the URL is a secret, not decoration. */
const hideToken = (url) => url.replace(/([?&]token=)[^&]*/, '$1…');

// Each poll spawns a `superset` process per terminal. With nobody watching, that is work for
// no one, so an unwatched server idles down to this and wakes the moment a page connects —
// which is what lets it run as a login service without being a permanent tax on the machine.
const IDLE_POLL_MS = Number(process.env.AGENT_FLEET_IDLE_POLL_MS ?? 20_000);

// Enough backlog that a browser opened mid-run still sees the recent conversation, capped so a
// long orchestration does not grow the process without bound.
const EVENT_HISTORY = 1500;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// Link history lives next to Superset's own state: it is derived from that state and useless
// without it. Point AGENT_FLEET_STATE elsewhere, or at '' to forget everything on restart.
const STATE_PATH =
  process.env.AGENT_FLEET_STATE === ''
    ? null
    : (process.env.AGENT_FLEET_STATE ?? join(homedir(), '.superset', 'agent-fleet.json'));

// Where `bin/superset-send` writes what it sent. The default matches the wrapper's own, so an
// orchestrator that uses it is picked up with nothing to configure on either side.
const LOG_PATH =
  process.env.AGENT_FLEET_LOG === ''
    ? null
    : (process.env.AGENT_FLEET_LOG ?? join(homedir(), '.superset', 'agent-fleet.jsonl'));

// Claude Code's own session transcripts, which are where an MCP-driven orchestrator's calls
// are recorded — the terminal never sees them. `CLAUDE_CONFIG_DIR` is Claude's own override;
// AGENT_FLEET_TRANSCRIPTS points somewhere else again, and '' switches the source off.
const TRANSCRIPT_ROOT =
  process.env.AGENT_FLEET_TRANSCRIPTS === ''
    ? null
    : (process.env.AGENT_FLEET_TRANSCRIPTS ??
      join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'));

const world = new World(STATE_PATH, LOG_PATH, TRANSCRIPT_ROOT, SCOPE);
await world.load();
const clients = new Set();
let latest = {
  tick: 0,
  at: Date.now(),
  agents: [],
  events: [],
  links: [],
  hubIds: [],
  error: null,
  logError: null,
  transcriptError: null,
};
const history = [];

function broadcast(payload) {
  for (const client of clients) {
    try {
      client.send(payload);
    } catch {
      clients.delete(client); // the browser went away between ticks
    }
  }
}

let wake = () => {};

async function pollForever() {
  for (;;) {
    const started = Date.now();
    try {
      const snapshot = await world.poll();
      history.push(...snapshot.events);
      if (history.length > EVENT_HISTORY) history.splice(0, history.length - EVENT_HISTORY);
      latest = snapshot;
      broadcast(snapshot);
    } catch (err) {
      latest = { ...latest, error: err.message };
      broadcast({ ...latest, agents: latest.agents, events: [] });
    }
    // Measure from the start of the poll: a slow tick should not also add its own delay.
    const interval = clients.size ? POLL_MS : IDLE_POLL_MS;
    const wait = Math.max(250, interval - (Date.now() - started));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, wait);
      // A page connecting mid-idle should not wait out the long interval.
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = () => {};
  }
}

async function serveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  // normalize() collapses any `..` before it can climb out of public/.
  const file = join(PUBLIC_DIR, normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return new Response('forbidden', { status: 403 });
  try {
    const body = await readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

function streamEvents() {
  const encoder = new TextEncoder();
  let client;
  const stream = new ReadableStream({
    start(controller) {
      client = {
        send: (payload) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
      };
      clients.add(client);
      // A browser that connects between ticks would otherwise stare at an empty world for a
      // full poll interval, so replay the last snapshot plus the recent event log immediately,
      // and pull the poller out of its idle wait.
      client.send({ ...latest, events: history });
      wake();
    },
    cancel() {
      clients.delete(client);
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}

/**
 * Every screen on this host is behind these routes, so an unauthenticated one is a terminal
 * reader offered to whoever can reach the port. When a token is set it is required; when one
 * is not, the server is on loopback and the question does not arise (see the bind check at
 * the bottom, which refuses the combination that would make it arise).
 */
function authorized(request) {
  if (!TOKEN) return true;
  const url = new URL(request.url);
  if (url.searchParams.get('token') === TOKEN) return true;
  return request.headers.get('authorization') === `Bearer ${TOKEN}`;
}

/**
 * Cross-origin access is granted only to a request that has ALREADY proved it has the token.
 * A blanket `*` would let any web page the user happens to visit read their fleet, which on a
 * tailnet is a page on the open internet reading terminals on a private network.
 */
function cors(request, response) {
  const origin = request.headers.get('origin');
  if (!origin || !TOKEN) return response;
  response.headers.set('access-control-allow-origin', origin);
  response.headers.set('vary', 'origin');
  return response;
}

async function handle(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/') && !authorized(request)) {
    return new Response('unauthorized', { status: 401 });
  }
  // A peer list is the browser's, not the server's: it says who else to go and ask.
  if (pathname === '/api/peers') {
    return cors(request, Response.json({ peers: PEERS, self: latest.hostName ?? null }));
  }
  if (pathname === '/api/stream') return cors(request, streamEvents());
  if (pathname === '/api/world')
    return cors(request, Response.json({ ...latest, events: history }));
  if (pathname === '/api/health') {
    return cors(
      request,
      Response.json({
        ok: true,
        tick: latest.tick,
        agents: latest.agents.length,
        watchers: clients.size,
        transport: transportNote(),
      }),
    );
  }
  if (pathname === '/api/terminal') {
    const id = new URL(request.url).searchParams.get('id');
    for (const agent of latest.agents) {
      const terminal = agent.terminals.find((t) => t.id === id);
      if (terminal) return Response.json({ ok: true, terminal, agent: agent.name });
    }
    return Response.json({ ok: false, error: 'unknown terminal' }, { status: 404 });
  }
  return serveStatic(pathname);
}

async function alreadyRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

if (await alreadyRunning()) {
  console.log(`Superset Agent Fleet is already running — http://localhost:${PORT}`);
  process.exit(0);
}

const version = await cliVersion();
if (!version) {
  console.error(
    'Superset Agent Fleet needs the `superset` CLI on PATH; `superset --version` did not run.',
  );
  process.exit(1);
}

// Publishing a terminal reader to a network without a token is not a thing to warn about and
// then do anyway. The two safe shapes are loopback-with-no-token and address-with-token; this
// refuses the third and names the fix rather than leaving the host quietly readable.
if (!isLoopback(BIND) && !TOKEN) {
  console.error(
    `Refusing to serve on ${BIND} without AGENT_FLEET_TOKEN.\n` +
      'Every terminal screen on this host is behind /api, so a bind beyond loopback needs one.\n' +
      'Set AGENT_FLEET_TOKEN=<secret>, or leave AGENT_FLEET_BIND unset to stay on 127.0.0.1.',
  );
  process.exit(1);
}
if (BIND === '0.0.0.0' || BIND === '::') {
  console.error(
    `Refusing to serve on ${BIND}: that is every interface, including any public one.\n` +
      'Name the address you mean — a tailnet address, or 127.0.0.1.',
  );
  process.exit(1);
}

Bun.serve({
  port: PORT,
  hostname: BIND,
  fetch: handle,
  error: () => new Response('error', { status: 500 }),
});
console.log(
  `Superset Agent Fleet  http://${BIND}:${PORT}   (${version}, polling every ${POLL_MS}ms)`,
);
// Which transport won is the difference between a millisecond and half a second per read, so
// it is said out loud rather than left to be inferred from how sluggish the world feels. The
// probe is awaited here rather than left to the first poll, so the banner reports a decision
// that has actually been made.
await useDirect();
console.log(`  reading through: ${transportNote()}`);
console.log(`  scope: ${SCOPE === 'host' ? 'this host only' : 'the whole fleet'}`);
if (PEERS.length) console.log(`  merging with: ${PEERS.map(hideToken).join(', ')}`);
if (TOKEN) console.log('  token required on /api');
pollForever();
