#!/usr/bin/env bun
// Read-only diagnostics. Never print CLI responses, manifests, or credentials.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { readConfig, healthURL, isFleetHealth } from '../lib/config.js';

export function runCommand(command, args, timeout = 10000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false });
    }, timeout);
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1000000) stdout += chunk;
    });
    child.stderr.resume();
    child.on('error', () => done({ ok: false }));
    child.on('close', (code) => done({ ok: code === 0, stdout }));
  });
}

export async function manifestCount(root) {
  let dirs;
  try {
    dirs = await readdir(join(root, 'host'));
  } catch {
    return 0;
  }
  let count = 0;
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(await readFile(join(root, 'host', dir, 'manifest.json'), 'utf8'));
      if (manifest?.endpoint && manifest?.authToken) count++;
    } catch {
      /* Missing and partially written manifests are unavailable. */
    }
  }
  return count;
}

async function portOpen(url) {
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => done(error.code !== 'ECONNREFUSED'));
  });
}

export async function checkHealth(config, token = '', fetcher = fetch) {
  const url = healthURL(config);
  try {
    const response = await fetcher(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    if (response.ok && isFleetHealth(await response.json().catch(() => null))) return 'fleet';
    return 'occupied';
  } catch {
    return (await portOpen(new URL(url))) ? 'occupied' : 'free';
  }
}

export async function diagnose({
  env = process.env,
  command = runCommand,
  manifests = manifestCount,
  health = checkHealth,
  version = Bun.version,
} = {}) {
  const checks = [];
  const add = (status, message) => checks.push({ status, message });
  const minimum = (await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim();
  const parseVersion = (value) => value.split('.').map(Number);
  const actual = parseVersion(version);
  const required = parseVersion(minimum);
  const supported =
    actual[0] > required[0] ||
    (actual[0] === required[0] &&
      (actual[1] > required[1] || (actual[1] === required[1] && actual[2] >= required[2])));
  add(supported ? 'ok' : 'fail', `Bun ${version}; minimum ${minimum}`);
  let config;
  try {
    config = readConfig(env);
    add('ok', `Configuration: ${healthURL(config).replace('/api/health', '')}`);
  } catch (error) {
    add('fail', error.message);
  }
  const cli = env.SUPERSET_CLI || 'superset';
  const available = await command(cli, ['--version']);
  add(
    available.ok ? 'ok' : 'fail',
    available.ok
      ? 'Superset CLI is available'
      : 'Superset CLI unavailable. Install Superset and add its CLI to PATH, or set SUPERSET_CLI.',
  );
  if (available.ok) {
    const auth = await command(cli, ['auth', 'whoami', '--json']);
    let authenticated = false;
    try {
      const start = auth.stdout?.indexOf('{') ?? -1;
      const data = start >= 0 ? JSON.parse(auth.stdout.slice(start)) : null;
      authenticated =
        auth.ok &&
        typeof data?.userId === 'string' &&
        typeof data?.organizationId === 'string' &&
        !data.error &&
        data.authenticated !== false;
    } catch {
      /* An unknown CLI response cannot prove authentication. */
    }
    add(
      authenticated ? 'ok' : 'fail',
      authenticated
        ? 'Superset account is signed in'
        : 'Could not verify Superset login. Run superset auth whoami, then superset auth login if needed.',
    );
    const status = await command(cli, ['status', '--json']);
    let running = false;
    try {
      const start = status.stdout?.indexOf('{') ?? -1;
      const data = start >= 0 ? JSON.parse(status.stdout.slice(start)) : null;
      running = status.ok && data?.running === true && data?.healthy !== false;
    } catch {
      /* Unknown output cannot prove the host is running. */
    }
    add(
      running ? 'ok' : 'fail',
      running
        ? 'Superset host service is running'
        : 'Could not verify a running, healthy Superset host. Open Superset and run superset status.',
    );
  }
  const count = await manifests(env.SUPERSET_HOME_DIR || join(homedir(), '.superset'));
  if (count > 1)
    add(
      'warn',
      `${count} host manifests found. Direct transport needs an unambiguous organization; CLI fallback is available.`,
    );
  else
    add(
      count === 1 ? 'ok' : 'warn',
      count === 1
        ? 'One local host manifest found'
        : 'No local host manifest found. Open Superset; CLI fallback is available.',
    );
  if (config) {
    const state = await health(config, env.AGENT_FLEET_TOKEN || '');
    add(
      state === 'occupied' ? 'fail' : 'ok',
      state === 'fleet'
        ? 'Agent Fleet is running on the configured port'
        : state === 'free'
          ? 'Configured port is available. Start with bun start.'
          : 'Configured port is occupied or returned an unrecognized health response. Stop that process yourself or change AGENT_FLEET_PORT.',
    );
  }
  if (env.AGENT_FLEET_PUSH_URL || env.AGENT_FLEET_PUSH_KEY)
    add(
      'warn',
      'Cloud reporting configuration is present. Check it before starting if you intended local-only use.',
    );
  return checks;
}

if (import.meta.main) {
  try {
    const checks = await diagnose();
    for (const check of checks)
      console.log(`${check.status.toUpperCase().padEnd(4)} ${check.message}`);
    process.exitCode = checks.some((check) => check.status === 'fail') ? 1 : 0;
  } catch {
    console.error('FAIL Could not complete diagnostics. Check the local installation.');
    process.exitCode = 1;
  }
}
