import { afterAll, describe, expect, test } from 'bun:test';
import { createDemoServer } from '../demo/server.js';
import { demoWorld } from '../demo/data.js';

const demo = createDemoServer({ port: 0 });
const base = demo.server.url;
afterAll(() => demo.stop());

describe('isolated demo', () => {
  test('binds to loopback and serves fictional data without peers', async () => {
    expect(demo.server.hostname).toBe('127.0.0.1');
    const world = await fetch(new URL('/api/world', base)).then((res) => res.json());
    expect(world.agents).toHaveLength(8);
    expect(new Set(world.agents.map((agent) => agent.owner))).toEqual(new Set(['Alex']));
    expect(world.agents.some((agent) => agent.status === 'working')).toBe(true);
    expect(world.agents.some((agent) => agent.status === 'waiting')).toBe(true);
    expect(world.agents.some((agent) => agent.status === 'idle')).toBe(true);
    expect(await fetch(new URL('/api/peers', base)).then((res) => res.json())).toEqual({
      peers: [],
      cloud: false,
      demo: true,
    });
  });

  test('uses deterministic sample data and an optional fictional street', () => {
    expect(demoWorld()).toEqual(demoWorld());
    expect(demoWorld({ team: true }).agents).toHaveLength(24);
  });

  test('streams a full world immediately', async () => {
    const res = await fetch(new URL('/api/stream?team=1', base));
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const message = JSON.parse(new TextDecoder().decode(value).slice(6).trim());
    expect(message.agents).toHaveLength(24);
    await reader.cancel();
  });

  test('pins stay in memory, reject unknown agents, and cannot be posted cross-origin', async () => {
    const post = (body, origin) =>
      fetch(new URL('/api/hub', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post({ id: 'alex-planner', pinned: true }, 'https://example.com')).status).toBe(
      403,
    );
    expect((await post({ id: 'real-agent', pinned: true })).status).toBe(400);
    expect((await post({ id: 'alex-planner', pinned: true })).status).toBe(200);
    const world = await fetch(new URL('/api/world', base)).then((res) => res.json());
    expect(world.pins).toContain('alex-planner');
    expect(world.hubIds).toContain('alex-planner');
    await post({ id: 'alex-planner', pinned: false });
  });

  test('serves real renderer assets and denies arbitrary repository files', async () => {
    const html = await fetch(base).then((res) => res.text());
    expect(html).toContain('/demo-bootstrap.js');
    expect(html).toContain('/app.js');
    expect((await fetch(new URL('/scene.js', base))).status).toBe(200);
    expect((await fetch(new URL('/.env', base))).status).toBe(404);
    expect((await fetch(new URL('/server.js', base))).status).toBe(404);
  });
});
