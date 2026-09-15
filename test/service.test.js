import { describe, expect, test } from 'bun:test';
import { renderService } from '../service/configure.js';

const base = {
  repo: '/tmp/fleet with spaces',
  home: '/tmp/home',
  bun: '/tmp/tools/bun',
  superset: '/tmp/tools/superset',
};

describe('optional background service configuration', () => {
  test('local Linux installation needs no cloud credentials', () => {
    const unit = renderService({ ...base, platform: 'linux' });
    expect(unit).toContain('WorkingDirectory="/tmp/fleet with spaces"');
    expect(unit).toContain('ExecStart="/tmp/tools/bun" "server.js"');
    expect(unit).not.toContain('doppler');
    expect(unit).not.toContain('EnvironmentFile');
  });

  test('systemd escapes percent specifiers, quotes, and ExecStart dollar expansion', () => {
    const unit = renderService({
      ...base,
      platform: 'linux',
      repo: '/tmp/100% "fleet"',
      bun: '/tmp/$tools/bun',
      config: 'team%name',
      doppler: '/tmp/doppler',
      project: 'our project',
    });
    expect(unit).toContain('WorkingDirectory="/tmp/100%% \\"fleet\\""');
    expect(unit).toContain('"/tmp/$$tools/bun" "server.js"');
    expect(unit).toContain('"-p" "our project" "-c" "team%%name"');
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
});
