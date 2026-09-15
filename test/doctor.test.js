import { describe, expect, test } from 'bun:test';
import { checkHealth, diagnose } from '../scripts/doctor.js';
import { readConfig } from '../lib/config.js';

const base = {
  env: {},
  version: '99.0.0',
  command: async (_, args) => ({
    ok: true,
    stdout:
      args[0] === 'auth'
        ? JSON.stringify({ userId: 'fictional-user', organizationId: 'fictional-org' })
        : JSON.stringify({ running: true, healthy: true }),
  }),
  manifests: async () => 1,
  health: async () => 'free',
};

describe('doctor', () => {
  test('accepts an authenticated local installation before the server is started', async () => {
    const checks = await diagnose(base);
    expect(checks.some((check) => check.status === 'fail')).toBe(false);
    expect(checks.some((check) => check.message.includes('port is available'))).toBe(true);
  });

  test('reports missing CLI, unsupported Bun, invalid config, and ambiguous manifests', async () => {
    const checks = await diagnose({
      ...base,
      env: { AGENT_FLEET_PORT: 'bad' },
      version: '0.0.1',
      command: async () => ({ ok: false }),
      manifests: async () => 2,
    });
    expect(checks.filter((check) => check.status === 'fail')).toHaveLength(3);
    expect(
      checks.some((check) => check.status === 'warn' && check.message.includes('2 host manifests')),
    ).toBe(true);
  });

  test('unknown auth output does not count as a login and credentials stay out of diagnostics', async () => {
    const secret = 'fixture-secret-value';
    const checks = await diagnose({
      ...base,
      env: { AGENT_FLEET_TOKEN: secret, AGENT_FLEET_PUSH_KEY: secret },
      command: async () => ({ ok: true, stdout: JSON.stringify({ message: secret }) }),
    });
    expect(checks.some((check) => check.status === 'fail' && check.message.includes('login'))).toBe(
      true,
    );
    expect(JSON.stringify(checks)).not.toContain(secret);
  });

  test('successful status command with a stopped host is a failure', async () => {
    const checks = await diagnose({
      ...base,
      command: async (cli, args) =>
        args[0] === 'status'
          ? { ok: true, stdout: JSON.stringify({ running: false }) }
          : base.command(cli, args),
    });
    expect(
      checks.some((check) => check.status === 'fail' && check.message.includes('Superset host')),
    ).toBe(true);
  });

  test('a successful HTTP response from another app is a port conflict', async () => {
    const state = await checkHealth(readConfig({}), '', async () => Response.json({ ok: true }));
    expect(state).toBe('occupied');
    const checks = await diagnose({ ...base, health: async () => state });
    expect(
      checks.some((check) => check.status === 'fail' && check.message.includes('occupied')),
    ).toBe(true);
  });

  test('health probes send tokens in a header and do not follow redirects', async () => {
    let request;
    const state = await checkHealth(
      readConfig({ AGENT_FLEET_PORT: '5544' }),
      'fixture-secret',
      async (url, options) => {
        request = { url, options };
        return Response.json({ ok: true, service: 'superset-agent-fleet' });
      },
    );
    expect(state).toBe('fleet');
    expect(request.url).toBe('http://127.0.0.1:5544/api/health');
    expect(request.options.headers.authorization).toBe('Bearer fixture-secret');
    expect(request.options.redirect).toBe('manual');
  });

  test('a non-HTTP listener is occupied and a closed port is available', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('another app'),
    });
    const config = readConfig({ AGENT_FLEET_PORT: String(server.port) });
    try {
      expect(
        await checkHealth(config, '', async () => {
          throw new Error('bad HTTP');
        }),
      ).toBe('occupied');
    } finally {
      server.stop(true);
    }
    expect(await checkHealth(config)).toBe('free');
  });
});
