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
import { cliVersion } from './lib/superset.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');

const PORT = Number(process.env.AGENT_FLEET_PORT ?? 4400);
const POLL_MS = Number(process.env.AGENT_FLEET_POLL_MS ?? 2500);

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

const world = new World(STATE_PATH, LOG_PATH);
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

async function handle(request) {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/stream') return streamEvents();
  if (pathname === '/api/world') return Response.json({ ...latest, events: history });
  if (pathname === '/api/health') {
    return Response.json({
      ok: true,
      tick: latest.tick,
      agents: latest.agents.length,
      watchers: clients.size,
    });
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

Bun.serve({
  port: PORT,
  fetch: handle,
  error: () => new Response('error', { status: 500 }),
});
console.log(
  `Superset Agent Fleet  http://localhost:${PORT}   (${version}, polling every ${POLL_MS}ms)`,
);
pollForever();
