import { expect, test } from 'bun:test';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Start the real server against a fictional CLI and two distinct temporary profile
// directories. A path calculation unit test would not prove either reader is wired up.
test('custom Superset home owns default state and send log, without reading the default profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fleet-custom-profile-'));
  let child;
  try {
    const home = join(root, 'home');
    const defaultProfile = join(home, '.superset');
    const profile = join(root, 'custom-superset');
    await mkdir(defaultProfile, { recursive: true });
    await mkdir(profile);
    const defaultState = JSON.stringify({ pins: ['wrong-profile-pin'] });
    await writeFile(join(defaultProfile, 'agent-fleet.json'), defaultState);
    await writeFile(join(profile, 'agent-fleet.json'), JSON.stringify({ pins: ['worker-a'] }));
    await writeFile(join(profile, 'agent-fleet.jsonl'), '');
    await writeFile(join(defaultProfile, 'agent-fleet.jsonl'), '');
    const cli = join(root, 'superset');
    await writeFile(
      cli,
      `#!${Bun.which('bun')}\n
const args = Bun.argv.slice(2);
const rows = ['worker-a','worker-b'].map(id => ({id,name:id,hostId:'fixture-host',type:'worktree'}));
if (args[0] === '--version') console.log('fixture-cli');
else if (args[0] === 'status') console.log(JSON.stringify({running:true,healthy:true,hostId:'fixture-host'}));
else if (args[0] === 'hosts') console.log(JSON.stringify([{id:'fixture-host',name:'Fictional host',online:true}]));
else if (args[0] === 'workspaces') console.log(JSON.stringify(rows));
else if (args[0] === 'terminals' && args[1] === 'list') console.log(JSON.stringify({sessions:[{terminalId:'fixture-terminal',title:'Codex'}]}));
else if (args[0] === 'terminals' && args[1] === 'read') console.log(JSON.stringify({text:'› Ask Codex to do anything'}));
else { console.log(JSON.stringify({error:'unexpected fixture command'})); process.exit(1); }
`,
    );
    await chmod(cli, 0o700);
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const base = reservation.url.origin;
    const port = reservation.port;
    reservation.stop(true);
    child = Bun.spawn(
      [Bun.which('bun'), '--no-env-file', new URL('../server.js', import.meta.url).pathname],
      {
        cwd: root,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          SUPERSET_HOME_DIR: profile,
          SUPERSET_CLI: cli,
          SUPERSET_TRANSPORT: 'cli',
          AGENT_FLEET_PORT: String(port),
          AGENT_FLEET_TRANSCRIPTS: '',
          AGENT_FLEET_WEATHER: 'off',
          AGENT_FLEET_POLL_MS: '50',
          AGENT_FLEET_IDLE_POLL_MS: '50',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    const waitFor = async (read, matches) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(await new Response(child.stderr).text());
        const value = await read().catch(() => null);
        if (value !== null && matches(value)) return value;
        await Bun.sleep(50);
      }
      throw new Error('Custom-profile server did not reach the expected state');
    };
    const readWorld = () => fetch(`${base}/api/world`).then((response) => response.json());
    const initial = await waitFor(
      readWorld,
      (world) => world.tick > 0 && world.agents.length === 2,
    );
    expect(initial.pins).toContain('worker-a');
    expect(initial.pins).not.toContain('wrong-profile-pin');

    const message = (text) =>
      JSON.stringify({
        at: Date.now(),
        kind: 'send',
        from: 'worker-a',
        to: 'worker-b',
        terminal: 'fixture-terminal',
        text,
      }) + '\n';
    await appendFile(join(defaultProfile, 'agent-fleet.jsonl'), message('Wrong profile message'));
    await appendFile(join(profile, 'agent-fleet.jsonl'), message('Custom profile message'));
    const observed = await waitFor(readWorld, (world) =>
      world.events.some((event) => event.text === 'Custom profile message'),
    );
    expect(observed.events.some((event) => event.text === 'Wrong profile message')).toBe(false);

    const response = await fetch(`${base}/api/hub`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'worker-b', pinned: true }),
    });
    expect(response.ok).toBe(true);
    const saved = await waitFor(
      () => readFile(join(profile, 'agent-fleet.json'), 'utf8').then(JSON.parse),
      (state) => state.pins.includes('worker-b'),
    );
    expect(saved.pins).toContain('worker-a');
    expect(saved.drives['worker-a']).toContain('worker-b');
    expect(await readFile(join(defaultProfile, 'agent-fleet.json'), 'utf8')).toBe(defaultState);
  } finally {
    if (child) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
