// Manual browser regression fixture: bun test/browser-server.js, then localhost:4414.
// Fictional data only. This server never imports the Superset adapter.
import { demoWorld, demoWeather } from '../demo/data.js';
import { join, extname } from 'node:path';

const root = join(import.meta.dir, '..');
let scenario = 'live';
let tick = 1;
const clients = new Set();
const pins = new Set();
function snapshot() {
  const world = demoWorld({ tick: tick++, pins: [...pins] });
  if (scenario === 'empty') world.agents = [];
  if (scenario === 'partial' || scenario === 'stale') {
    world.error = 'Fictional host temporarily unavailable';
    world.agents = world.agents.map((agent, i) => ({
      ...agent,
      stale: scenario === 'stale' || i < 2,
      observedAt: Date.now() - 60_000,
    }));
  }
  return world;
}
function push() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const send of clients) send(data);
}
const toolbar = `<div style="position:fixed;bottom:8px;left:8px;right:8px;width:fit-content;max-width:calc(100% - 16px);display:flex;flex-wrap:wrap;gap:4px;z-index:1000;background:#141c29;padding:8px" aria-label="Fixture controls">${['live', 'partial', 'stale', 'empty'].map((name) => `<button data-scenario="${name}">${name}</button>`).join('')} <a href="/test/dom">DOM regression checks</a></div><script>document.querySelectorAll('[data-scenario]').forEach(button=>button.onclick=()=>fetch('/scenario',{method:'POST',body:button.dataset.scenario}));</script>`;
Bun.serve({
  hostname: '127.0.0.1',
  port: 4414,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && request.headers.get('origin') !== url.origin)
      return new Response('Forbidden', { status: 403 });
    if (url.pathname === '/scenario' && request.method === 'POST') {
      const next = await request.text();
      if (!['live', 'partial', 'stale', 'empty'].includes(next))
        return new Response('', { status: 400 });
      scenario = next;
      push();
      return new Response('ok');
    }
    if (url.pathname === '/api/hub' && request.method === 'POST') {
      const { id, pinned } = await request.json();
      if (pinned === false) pins.delete(id);
      else pins.add(id);
      push();
      return Response.json({ ok: true, pins: [...pins], hubIds: snapshot().hubIds });
    }
    if (url.pathname === '/api/peers')
      return Response.json({ peers: [], cloud: false, demo: true });
    if (url.pathname === '/api/weather') return Response.json(demoWeather);
    if (url.pathname === '/api/world') return Response.json(snapshot());
    if (url.pathname === '/api/stream') {
      let send;
      return new Response(
        new ReadableStream({
          start(controller) {
            send = (data) => {
              try {
                controller.enqueue(new TextEncoder().encode(data));
              } catch {
                clients.delete(send);
              }
            };
            clients.add(send);
            send(`data: ${JSON.stringify(snapshot())}\n\n`);
          },
          cancel() {
            clients.delete(send);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (url.pathname === '/test/dom')
      return new Response(Bun.file(join(root, 'test/dom-browser.html')));
    if (url.pathname === '/demo-bootstrap.js')
      return new Response(Bun.file(join(root, 'demo/bootstrap.js')));
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!/^[a-z-]+\.(html|css|js)$/.test(name)) return new Response('', { status: 404 });
    const file = Bun.file(join(root, 'public', name));
    if (!(await file.exists())) return new Response('', { status: 404 });
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    const body =
      name === 'index.html'
        ? (await file.text()).replace(
            '<script type="module" src="/app.js"></script>',
            `${toolbar}<script src="/demo-bootstrap.js"></script><script type="module" src="/app.js"></script>`,
          )
        : file;
    return new Response(body, {
      headers: { 'content-type': types[extname(name)], 'cache-control': 'no-store' },
    });
  },
});
setInterval(push, 2000);
console.log('Browser fixtures: http://127.0.0.1:4414 (fictional data only)');
