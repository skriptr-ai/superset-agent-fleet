#!/usr/bin/env bun
// An isolated local demo. It imports no production backend and makes no outbound requests.
import { join, extname } from 'node:path';
import { demoWorld, demoWeather } from './data.js';

const PUBLIC = join(import.meta.dir, '../public');
const ASSETS = new Set([
  'index.html',
  'app.js',
  'style.css',
  'scene.js',
  'draw.js',
  'daylight.js',
  'weather.js',
  'district.js',
  'street.js',
  'city.js',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function createDemoServer({ port = 4401 } = {}) {
  const pins = new Set();
  const clients = new Set();
  let tick = 1;
  const snapshot = (team) => demoWorld({ team, tick, pins: [...pins] });
  const push = () => {
    for (const client of clients) {
      try {
        client.send(snapshot(client.team));
      } catch {
        clients.delete(client);
      }
    }
  };
  const timer = setInterval(() => {
    tick++;
    push();
  }, 5000);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const team = url.searchParams.get('team') === '1';
      if (url.pathname === '/api/hub' && request.method === 'POST') {
        if (request.headers.get('origin') && request.headers.get('origin') !== url.origin)
          return new Response('Forbidden', { status: 403 });
        let body;
        try {
          body = await request.json();
        } catch {
          return new Response('Invalid JSON', { status: 400 });
        }
        if (!demoWorld({ team: true }).agents.some((agent) => agent.id === body?.id))
          return new Response('Unknown demo agent', { status: 400 });
        if (body.pinned === false) pins.delete(body.id);
        else pins.add(body.id);
        push();
        return Response.json({ ok: true, pins: [...pins], hubIds: snapshot(team).hubIds });
      }
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/api/peers')
        return Response.json({ peers: [], cloud: false, demo: true });
      if (url.pathname === '/api/world') return Response.json(snapshot(team));
      if (url.pathname === '/api/weather') return Response.json(demoWeather);
      if (url.pathname === '/api/health')
        return Response.json({ ok: true, demo: true, agents: snapshot(team).agents.length });
      if (url.pathname === '/api/stream') {
        let client;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            client = {
              team,
              send: (world) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(world)}\n\n`)),
            };
            clients.add(client);
            client.send(demoWorld({ team, pins: [...pins] }));
          },
          cancel() {
            clients.delete(client);
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      }
      if (url.pathname === '/demo-bootstrap.js')
        return new Response(Bun.file(join(import.meta.dir, 'bootstrap.js')), {
          headers: { 'content-type': MIME['.js'] },
        });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!ASSETS.has(name)) return new Response('Not found', { status: 404 });
      const file = Bun.file(join(PUBLIC, name));
      if (name === 'index.html') {
        const html = (await file.text()).replace(
          '<script type="module" src="/app.js"></script>',
          '<script src="/demo-bootstrap.js"></script>\n    <script type="module" src="/app.js"></script>',
        );
        return new Response(html, {
          headers: { 'content-type': MIME['.html'], 'cache-control': 'no-store' },
        });
      }
      return new Response(file, { headers: { 'content-type': MIME[extname(name)] } });
    },
  });
  return {
    server,
    stop() {
      clearInterval(timer);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.AGENT_FLEET_DEMO_PORT ?? 4401);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('AGENT_FLEET_DEMO_PORT must be an integer from 1 to 65535.');
  const { server } = createDemoServer({ port });
  console.log(
    `Demo: ${server.url}\nFictional sessions only. No Superset login needed.\nAdd ?still=1 to pause the scene for screenshots.`,
  );
}
