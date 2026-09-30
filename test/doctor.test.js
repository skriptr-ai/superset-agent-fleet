import { describe, expect, test } from 'bun:test';
import { checkHealth, diagnose } from '../scripts/doctor.js';
import { readConfig } from '../lib/config.js';

const laptop = { id: 'fictional-laptop-id', name: 'fictional-laptop', online: 'yes' };

function answers(hosts = [laptop]) {
  return async (_, args) => ({
    ok: true,
    stdout:
      args[0] === 'auth'
        ? JSON.stringify({ userId: 'fictional-user', organizationId: 'fictional-org' })
        : args[0] === 'hosts'
          ? JSON.stringify(hosts)
          : JSON.stringify({ running: true, healthy: true, hostId: laptop.id }),
  });
}

const base = {
  env: {},
  version: '99.0.0',
  command: answers(),
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

  describe('remote hosts', () => {
    const vm = { id: 'fictional-vm-id', name: 'fictional-vm', online: 'yes' };
    const asleep = { id: 'fictional-asleep-id', name: 'fictional-asleep', online: 'no' };
    const find = (checks, text) => checks.find((check) => check.message.includes(text));

    test('host scope with another host online suggests fleet scope', async () => {
      const checks = await diagnose({ ...base, command: answers([laptop, vm]) });
      expect(find(checks, 'AGENT_FLEET_SCOPE=fleet')?.status).toBe('warn');
      expect(checks.some((check) => check.status === 'fail')).toBe(false);
    });

    test('this machine alone is not a remote host, matched by id or name', async () => {
      const checks = await diagnose(base);
      expect(find(checks, 'No other Superset hosts online')?.status).toBe('ok');
      const renamed = { ...laptop, id: 'another-id' };
      const byName = await diagnose({
        ...base,
        command: async (cli, args) =>
          args[0] === 'status'
            ? { ok: true, stdout: JSON.stringify({ running: true, hostName: laptop.name }) }
            : answers([renamed])(cli, args),
      });
      expect(find(byName, 'No other Superset hosts online')?.status).toBe('ok');
    });

    test('fleet scope counts online hosts and warns about offline ones', async () => {
      const checks = await diagnose({
        ...base,
        env: { AGENT_FLEET_SCOPE: 'fleet' },
        command: answers([laptop, vm, asleep]),
      });
      expect(find(checks, '1 other host online')?.status).toBe('ok');
      expect(find(checks, '1 other host offline')?.status).toBe('warn');
    });

    test('fleet scope with no other hosts is a warning', async () => {
      const checks = await diagnose({ ...base, env: { AGENT_FLEET_SCOPE: 'fleet' } });
      expect(find(checks, 'sees no other Superset hosts')?.status).toBe('warn');
    });

    test('a failed host list warns without failing, and host names stay out of output', async () => {
      const failed = await diagnose({
        ...base,
        command: async (cli, args) => (args[0] === 'hosts' ? { ok: false } : answers()(cli, args)),
      });
      expect(find(failed, 'Could not list Superset hosts')?.status).toBe('warn');
      expect(failed.some((check) => check.status === 'fail')).toBe(false);
      const listed = await diagnose({ ...base, command: answers([laptop, vm, asleep]) });
      expect(JSON.stringify(listed)).not.toContain('fictional-vm');
      expect(JSON.stringify(listed)).not.toContain('fictional-asleep');
    });

    test('a stopped host service skips the host list', async () => {
      const calls = [];
      await diagnose({
        ...base,
        command: async (cli, args) => {
          calls.push(args[0]);
          return args[0] === 'status'
            ? { ok: true, stdout: JSON.stringify({ running: false }) }
            : answers()(cli, args);
        },
      });
      expect(calls).not.toContain('hosts');
    });
  });
});
