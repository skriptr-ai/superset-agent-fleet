import { describe, expect, test } from 'bun:test';
import { renderService, writeServiceFile } from '../service/configure.js';
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = {
  repo: '/tmp/fleet with spaces',
  home: '/tmp/home',
  bun: '/tmp/tools/bun',
  superset: '/tmp/tools/superset',
};

describe('optional background service configuration', () => {
  test('local Linux installation needs no cloud credentials', () => {
    const unit = renderService({ ...base, platform: 'linux' });
    expect(unit).toContain('WorkingDirectory=/tmp/fleet with spaces\n');
    expect(unit).toContain('ExecStart=:"/tmp/tools/bun" "server.js"');
    expect(unit).not.toContain('doppler');
    expect(unit).not.toContain('EnvironmentFile');
  });

  test('systemd literal paths remain absolute and command dollar expansion is disabled', () => {
    const unit = renderService({
      ...base,
      platform: 'linux',
      repo: '/tmp/100% "fleet"',
      bun: '/tmp/$tools/bun',
      config: 'team%name',
      doppler: '/tmp/doppler',
      project: 'our project',
      home: '/tmp/home with spaces',
    });
    expect(unit).toContain('WorkingDirectory=/tmp/100%% "fleet"\n');
    expect(unit).toContain(
      'EnvironmentFile=-/tmp/home with spaces/.config/superset-agent-fleet/doppler.env\n',
    );
    expect(unit).toContain('ExecStart=:"/tmp/doppler"');
    expect(unit).toContain('"/tmp/$tools/bun" "server.js"');
    expect(unit).toContain('"-p" "our project" "-c" "team%%name"');
  });

  test('systemd preserves a dollar sign in the executable path and literal environment values', () => {
    const unit = renderService({
      ...base,
      platform: 'linux',
      bun: '/tmp/$tools/bun',
      env: { AGENT_FLEET_OWNER: 'Alex "$team"' },
    });
    expect(unit).toContain('ExecStart=:"/tmp/$tools/bun" "server.js"');
    expect(unit).toContain('Environment="AGENT_FLEET_OWNER=Alex \\"$team\\""');
  });

  test('launchd preserves the existing service identity and escapes XML values', () => {
    const plist = renderService({
      ...base,
      platform: 'darwin',
      repo: '/tmp/fleet & <friends>',
      config: 'team',
      doppler: '/tmp/doppler',
      token: 'fixture<&token',
    });
    expect(plist).toContain('<string>ai.skriptr.superset-agent-fleet</string>');
    expect(plist).toContain('/tmp/fleet &amp; &lt;friends&gt;');
    expect(plist).toContain('fixture&lt;&amp;token');
  });

  test('explicit environment overrides survive service startup', () => {
    const unit = renderService({
      ...base,
      platform: 'linux',
      env: { AGENT_FLEET_PORT: '5544', AGENT_FLEET_TOKEN: 'fixture-secret', UNRELATED: 'skip' },
    });
    expect(unit).toContain('Environment="AGENT_FLEET_PORT=5544"');
    expect(unit).toContain('Environment="AGENT_FLEET_TOKEN=fixture-secret"');
    expect(unit).not.toContain('UNRELATED');
  });

  test('newline injection cannot add service directives', () => {
    expect(() =>
      renderService({ ...base, platform: 'linux', repo: '/tmp/fleet\nExecStart=oops' }),
    ).toThrow('newlines');
  });

  test('agent workspace context and ambient Superset credentials are not persisted', () => {
    for (const platform of ['linux', 'darwin']) {
      const definition = renderService({
        ...base,
        platform,
        env: {
          SUPERSET_WORKSPACE_ID: 'temporary-workspace',
          SUPERSET_TERMINAL_ID: 'temporary-terminal',
          SUPERSET_ORGANIZATION_ID: 'temporary-org',
          SUPERSET_API_KEY: 'fixture-secret',
          SUPERSET_HOME_DIR: '/tmp/custom-superset',
          SUPERSET_TRANSPORT: 'cli',
          CLAUDE_CONFIG_DIR: '/tmp/custom-claude',
        },
      });
      expect(definition).not.toContain('temporary-');
      expect(definition).not.toContain('fixture-secret');
      expect(definition).toContain('/tmp/custom-superset');
      expect(definition).toContain('SUPERSET_TRANSPORT');
      expect(definition).toContain('/tmp/custom-claude');
    }
  });

  test('reinstall replaces a world-readable definition with a private complete file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-service-permissions-'));
    const target = join(directory, 'fleet.service');
    await writeFile(target, 'old definition');
    await chmod(target, 0o644);
    const definition = renderService({
      ...base,
      platform: 'linux',
      env: { AGENT_FLEET_TOKEN: 'fixture-only' },
    });
    await writeServiceFile(target, definition);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, 'utf8')).toBe(definition);
  });

  const analyzer = process.platform === 'linux' ? Bun.which('systemd-analyze') : null;
  test.skipIf(!analyzer)(
    'systemd accepts the generated unit without installing or starting it',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'fleet service $% '));
      const executable = join(directory, '$tool');
      await symlink(process.execPath, executable);
      const target = join(directory, 'fleet-verify.service');
      await writeServiceFile(
        target,
        renderService({
          platform: 'linux',
          repo: directory,
          home: directory,
          bun: executable,
          superset: executable,
          doppler: executable,
          config: 'fictional',
        }),
      );
      const child = Bun.spawn([analyzer, 'verify', '--man=no', target], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(status, stderr).toBe(0);
    },
  );
});
