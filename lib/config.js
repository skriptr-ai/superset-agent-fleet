// Configuration shared by the server, doctor, and optional background services.
import { isIP } from 'node:net';

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function choice(env, name, fallback, values) {
  const value = env[name] ?? fallback;
  if (!values.includes(value)) throw new Error(`${name} must be ${values.join(' or ')}`);
  return value;
}

function coordinate(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

export function readConfig(env = process.env) {
  const bind = env.AGENT_FLEET_BIND ?? '127.0.0.1';
  if (bind !== 'localhost' && !isIP(bind)) {
    throw new Error('AGENT_FLEET_BIND must be an IP address or localhost');
  }
  const tz = env.AGENT_FLEET_TZ ?? 'Europe/Oslo';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz }).format();
  } catch {
    throw new Error('AGENT_FLEET_TZ must be a valid time zone, such as Europe/Oslo');
  }
  return {
    port: integer(env, 'AGENT_FLEET_PORT', 4400, 1, 65535),
    bind,
    pollMs: integer(env, 'AGENT_FLEET_POLL_MS', 2500, 1, 2147483647),
    idlePollMs: integer(env, 'AGENT_FLEET_IDLE_POLL_MS', 20000, 1, 2147483647),
    cliInflight: integer(env, 'AGENT_FLEET_CLI_INFLIGHT', 12, 1, 64),
    scope: choice(env, 'AGENT_FLEET_SCOPE', 'host', ['host', 'fleet']),
    transport: choice(env, 'SUPERSET_TRANSPORT', 'auto', ['auto', 'cli']),
    weatherEnabled: choice(env, 'AGENT_FLEET_WEATHER', 'on', ['on', 'off']) === 'on',
    place: {
      name: env.AGENT_FLEET_PLACE ?? 'Oslo',
      tz,
      lat: coordinate(env, 'AGENT_FLEET_LAT', 59.9139, -90, 90),
      lon: coordinate(env, 'AGENT_FLEET_LON', 10.7522, -180, 180),
    },
  };
}

export function healthURL(config) {
  const host = config.bind === '0.0.0.0' ? '127.0.0.1' : config.bind === '::' ? '::1' : config.bind;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}/api/health`;
}

export function isFleetHealth(body) {
  return body?.ok === true && body?.service === 'superset-agent-fleet';
}
