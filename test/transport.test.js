import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHostManifest } from '../lib/manifest.js';

const roots = [];
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'fleet-transport-'));
  roots.push(root);
  return root;
}
async function manifest(root, org, endpoint) {
  const dir = join(root, 'host', org);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({ endpoint, authToken: 'fixture-only' }),
  );
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('Superset organization discovery', () => {
  test('an absent host leaves selection to the CLI', async () => {
    expect((await readHostManifest(await sandbox())).manifest).toBeNull();
  });
  test('a single loopback manifest supports the fast path', async () => {
    const root = await sandbox();
    await manifest(root, 'org-a', 'http://127.0.0.1:9999');
    expect((await readHostManifest(root)).manifest.endpoint).toBe('http://127.0.0.1:9999');
  });
  test('two organizations never silently pick the first one', async () => {
    const root = await sandbox();
    await manifest(root, 'org-a', 'http://127.0.0.1:9999');
    await manifest(root, 'org-b', 'http://127.0.0.1:9998');
    expect(await readHostManifest(root)).toEqual({
      manifest: null,
      reason: 'multiple organization manifests',
    });
  });
  test('a manifest cannot send its credential to a remote endpoint', async () => {
    const root = await sandbox();
    await manifest(root, 'org-a', 'https://example.com');
    expect((await readHostManifest(root)).manifest).toBeNull();
  });
});

async function callInChild(root, { transport = 'auto', exitCode = 0 } = {}) {
  const cli = join(root, 'superset');
  await writeFile(
    cli,
    `#!${process.execPath}\nconsole.log(JSON.stringify({source: 'cli'})); process.exit(${exitCode});\n`,
  );
  await chmod(cli, 0o700);
  const module = new URL('../lib/transport.js', import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--eval',
      `const {call}=await import(${JSON.stringify(module)}); console.log(JSON.stringify(await call({proc:'workspace.list',cli:['workspaces','list']})));`,
    ],
    {
      env: {
        PATH: process.env.PATH,
        SUPERSET_HOME_DIR: root,
        SUPERSET_CLI: cli,
        SUPERSET_TRANSPORT: transport,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(output);
}

describe('transport fallback', () => {
  test('HTTP errors and unfamiliar response envelopes use the CLI', async () => {
    for (const response of [
      () => Response.json({ result: { data: { json: [] } } }, { status: 500 }),
      () => Response.json({ changed: true }),
      () => Response.json({ result: { data: { json: null } } }),
      () => Response.json({ result: { data: { json: { unexpected: [] } } } }),
    ]) {
      const host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: response });
      try {
        const root = await sandbox();
        await manifest(root, 'org-a', host.url.origin);
        expect(await callInChild(root)).toEqual({ ok: true, data: { source: 'cli' } });
      } finally {
        host.stop(true);
      }
    }
  });
  test('forcing the CLI skips the private endpoint', async () => {
    let requests = 0;
    const host = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        requests++;
        return Response.json({ result: { data: { json: [] } } });
      },
    });
    try {
      const root = await sandbox();
      await manifest(root, 'org-a', host.url.origin);
      expect((await callInChild(root, { transport: 'cli' })).data.source).toBe('cli');
      expect(requests).toBe(0);
    } finally {
      host.stop(true);
    }
  });
  test('a failing CLI cannot look like an empty successful fleet', async () => {
    expect(await callInChild(await sandbox(), { exitCode: 1 })).toEqual({
      ok: false,
      error: 'superset exited with status 1',
    });
  });
});
