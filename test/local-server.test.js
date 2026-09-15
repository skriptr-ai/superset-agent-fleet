import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root;
let process;
let base;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-new-account-'));
  const cli = join(root, 'superset');
  await writeFile(
    cli,
    `#!${Bun.which('bun')}\n
const args = Bun.argv.slice(2);
if (args[0] === '--version') { console.log('fixture-cli'); }
else if (args[0] === 'status') { console.log(JSON.stringify({running:true,healthy:true,hostId:'fixture-host'})); }
else if (args[0] === 'hosts') { console.log(JSON.stringify([{id:'fixture-host',name:'Fixture machine',online:true}])); }
else if (args[0] === 'workspaces') { console.log('[]'); }
else { console.log(JSON.stringify({error:'unexpected fixture command'})); process.exit(1); }
`,
  );
  await chmod(cli, 0o700);
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  base = reservation.url.origin;
  const port = reservation.port;
  reservation.stop(true);
  process = Bun.spawn(
    [Bun.which('bun'), '--no-env-file', new URL('../server.js', import.meta.url).pathname],
    {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        SUPERSET_HOME_DIR: root,
        SUPERSET_CLI: cli,
        SUPERSET_TRANSPORT: 'cli',
        AGENT_FLEET_PORT: String(port),
        AGENT_FLEET_STATE: '',
        AGENT_FLEET_LOG: '',
        AGENT_FLEET_TRANSCRIPTS: '',
        AGENT_FLEET_WEATHER: 'off',
        AGENT_FLEET_POLL_MS: '100',
        AGENT_FLEET_IDLE_POLL_MS: '100',
      },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const health = await fetch(`${base}/api/health`).then((res) => res.json());
      if (health.tick > 0) return;
    } catch {
      /* The isolated server is still starting. */
    }
    if (process.exitCode !== null) throw new Error(await new Response(process.stderr).text());
    await Bun.sleep(50);
  }
  throw new Error('Isolated local server did not finish a poll');
}, 10000);
afterAll(async () => {
  if (process) {
    process.kill();
    await process.exited;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('a fresh empty account works without company config or cloud services', async () => {
  const health = await fetch(`${base}/api/health`).then((res) => res.json());
  expect(health.service).toBe('superset-agent-fleet');
  expect(health.cloud).toBeNull();
  const world = await fetch(`${base}/api/world`).then((res) => res.json());
  expect(world.scope).toBe('host');
  expect(world.agents).toEqual([]);
  expect(world.error).toBeNull();
  expect(await fetch(`${base}/api/weather`).then((res) => res.json())).toMatchObject({
    disabled: true,
    weather: null,
  });
  expect(await fetch(base).then((res) => res.text())).toContain('Opening your restaurant');
});

test('local APIs reject foreign hostnames and cross-origin writes', async () => {
  expect(
    (await fetch(`${base}/api/world`, { headers: { host: 'untrusted.example' } })).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/hub`, {
        method: 'POST',
        headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'anything' }),
      })
    ).status,
  ).toBe(403);
  expect((await fetch(`${base}/.env`)).status).toBe(404);
});
