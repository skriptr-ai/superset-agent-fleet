#!/usr/bin/env bun
// Render service definitions without shell interpolation of paths or credentials.
import { writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig, healthURL } from '../lib/config.js';
import { checkHealth } from '../scripts/doctor.js';

const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char],
  );
const clean = (value) => {
  if (/[\r\n\0]/.test(value))
    throw new Error('Service paths and values must not contain newlines or NUL');
  return value;
};
const unitQuote = (value) =>
  `"${clean(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

// These directives take a literal path, unlike Environment and ExecStart's words.
// Quoting a WorkingDirectory makes its first character a quote, not '/'.
const unitPath = (value) => clean(value).replace(/%/g, '%%');

// A reinstall must replace a previously permissive file with a private one before
// writing credentials. Rename also leaves the old definition intact on write failure.
export async function writeServiceFile(target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
}

export function renderService({
  platform,
  repo,
  home,
  bun,
  superset,
  doppler = '',
  config = '',
  project = 'agent-fleet',
  token = '',
  env = {},
}) {
  [repo, home, bun, superset, doppler, config, project, token].forEach(clean);
  const path = [
    bun.slice(0, bun.lastIndexOf('/')),
    superset.slice(0, superset.lastIndexOf('/')),
    join(home, '.superset/bin'),
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
  const args = config
    ? [doppler, 'run', '-p', project, '-c', config, '--', bun, 'server.js']
    : [bun, 'server.js'];
  // Persist configuration, never the terminal/workspace/auth context inherited from
  // an agent that happened to invoke the installer. Bun loads .env at service startup.
  const supersetSettings = new Set(['SUPERSET_HOME_DIR', 'SUPERSET_TRANSPORT']);
  const settings = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) =>
        key.startsWith('AGENT_FLEET_') || supersetSettings.has(key) || key === 'CLAUDE_CONFIG_DIR',
    ),
  );
  // Exact executable path also honors a CLI installed outside the usual shell PATH.
  const variables = { PATH: path, HOME: home, ...settings, SUPERSET_CLI: superset };
  if (platform === 'darwin') {
    if (config && token) variables.DOPPLER_TOKEN = token;
    const replacements = {
      __BUN__: xml(bun),
      __REPO__: xml(repo),
      __PATH__: xml(path),
      __HOME__: xml(home),
      __DOPPLER__: args
        .slice(0, -2)
        .map((arg) => `<string>${xml(arg)}</string>`)
        .join(''),
      __DOPPLER_ENV__: Object.entries(variables)
        .filter(([key]) => key !== 'HOME' && key !== 'PATH')
        .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
        .join(''),
    };
    const template = readFileSync(
      new URL('./ai.skriptr.superset-agent-fleet.plist.template', import.meta.url),
      'utf8',
    );
    return template.replace(
      /__(?:BUN|REPO|PATH|HOME|DOPPLER|DOPPLER_ENV)__/g,
      (key) => replacements[key],
    );
  }
  if (platform !== 'linux') throw new Error('Service installation supports macOS and Linux');
  // ':' disables ExecStart environment expansion; paths and arguments are already
  // resolved. A literal '$' in an executable path must not become '$$' on disk.
  return `[Unit]
Description=Superset Agent Fleet
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${unitPath(/[\\\s]$/.test(repo) ? `${repo}/` : repo)}
${Object.entries(variables)
  .map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`)
  .join('\n')}
${config ? `EnvironmentFile=-${unitPath(join(home, '.config/superset-agent-fleet/doppler.env'))}\n` : ''}ExecStart=:${args.map(unitQuote).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

if (import.meta.main) {
  try {
    const [
      action,
      platform,
      target,
      bun,
      superset,
      doppler = '',
      config = '',
      project = 'agent-fleet',
    ] = process.argv.slice(2);
    const settings = action === 'render' ? null : readConfig();
    if (action === 'cli') {
      const cli = Bun.which(process.env.SUPERSET_CLI || 'superset');
      if (!cli) throw new Error('Superset CLI is not available; install it or set SUPERSET_CLI');
      console.log(cli);
    } else if (action === 'url') console.log(healthURL(settings).replace('/api/health', ''));
    else if (action === 'probe') {
      const state = await checkHealth(settings, process.env.AGENT_FLEET_TOKEN || '');
      process.exitCode = state === 'fleet' ? 0 : state === 'free' ? 1 : 2;
    } else if (action === 'render') {
      // Avoid freezing .env values into a service: it must reread the file after edits.
      await writeServiceFile(
        target,
        renderService({
          platform,
          repo: process.cwd(),
          home: process.env.HOME,
          bun,
          superset,
          doppler,
          config,
          project,
          token: process.env.DOPPLER_TOKEN || '',
          env: process.env,
        }),
      );
    } else throw new Error('Unknown service helper action');
  } catch (error) {
    console.error(`agent-fleet: ${error.message}`);
    process.exitCode = 3;
  }
}
