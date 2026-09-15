import { describe, expect, test } from 'bun:test';
import { readConfig, healthURL, isFleetHealth } from '../lib/config.js';

describe('local configuration', () => {
  test('defaults to this host on loopback', () => {
    const config = readConfig({});
    expect(config.port).toBe(4400);
    expect(config.bind).toBe('127.0.0.1');
    expect(config.scope).toBe('host');
    expect(config.weatherEnabled).toBe(true);
    expect(healthURL(config)).toBe('http://127.0.0.1:4400/api/health');
  });

  test('explicit fleet, weather, transport, and address settings are retained', () => {
    const config = readConfig({
      AGENT_FLEET_PORT: '5544',
      AGENT_FLEET_BIND: '::1',
      AGENT_FLEET_SCOPE: 'fleet',
      AGENT_FLEET_WEATHER: 'off',
      SUPERSET_TRANSPORT: 'cli',
      AGENT_FLEET_TZ: 'UTC',
      AGENT_FLEET_LAT: '0',
      AGENT_FLEET_LON: '0',
    });
    expect(config.scope).toBe('fleet');
    expect(config.transport).toBe('cli');
    expect(config.weatherEnabled).toBe(false);
    expect(config.place.lat).toBe(0);
    expect(healthURL(config)).toBe('http://[::1]:5544/api/health');
    expect(healthURL({ ...config, bind: '0.0.0.0' })).toBe('http://127.0.0.1:5544/api/health');
  });

  for (const [name, value] of Object.entries({
    AGENT_FLEET_PORT: '4400junk',
    AGENT_FLEET_POLL_MS: '0',
    AGENT_FLEET_IDLE_POLL_MS: 'NaN',
    AGENT_FLEET_CLI_INFLIGHT: '-1',
    AGENT_FLEET_SCOPE: 'typo',
    AGENT_FLEET_BIND: 'https://localhost',
    AGENT_FLEET_TZ: 'no-such-zone',
    AGENT_FLEET_LAT: '91',
    AGENT_FLEET_LON: '',
    AGENT_FLEET_WEATHER: 'yes',
    SUPERSET_TRANSPORT: 'direct',
  })) {
    test(`rejects invalid ${name} without echoing its value`, () => {
      expect(() => readConfig({ [name]: value })).toThrow(name);
    });
  }

  test('an unrelated health endpoint is not an Agent Fleet instance', () => {
    expect(isFleetHealth({ ok: true })).toBe(false);
    expect(isFleetHealth({ ok: true, service: 'another-app' })).toBe(false);
    expect(isFleetHealth({ ok: false, service: 'superset-agent-fleet' })).toBe(false);
    expect(isFleetHealth({ ok: true, service: 'superset-agent-fleet' })).toBe(true);
  });
});
