// What the fleet looks like, asked for in whichever way is cheapest.
//
// Superset Agent Fleet reads the fleet through the same questions the orchestrator's own CLI
// asks, rather than through the host's sqlite. That is deliberate: it can then only ever
// display a state the orchestrator could itself have observed, so a disagreement between
// the picture and the agents is a bug in this tool and not a second source of truth.
//
// HOW those questions travel is a separate matter, and lib/transport.js owns it: the host
// service's own tRPC endpoint where it reaches, the real `superset` binary everywhere else.
// The rows are the same either way — parity was checked field by field — so nothing below
// this line, and nothing above it in world.js, knows or cares which one answered.
//
// Every workspace command in that CLI defaults to THIS MACHINE. `workspaces list` with no
// `--host` is `--local`, and `terminals list/read` answer `Workspace not found on host <local>`
// for anything else. A fleet spread over a laptop and a VM is therefore not partly visible
// through those defaults — it is invisible past the machine the server happens to run on. So
// the fleet is enumerated host by host here, and every later call carries the host its
// workspace lives on.

import { spawn } from 'node:child_process';
import {
  call,
  callDirectOnly,
  runCli,
  useDirect,
  transportNote,
  hasBackgroundCliCapacity,
} from './transport.js';

const CLI = process.env.SUPERSET_CLI || 'superset';

export { transportNote, useDirect };

function rowsOf(data, key, idKey = 'id') {
  const rows = Array.isArray(data) ? data : data?.[key];
  return Array.isArray(rows) && rows.every((row) => row && typeof row[idKey] === 'string')
    ? rows
    : null;
}

const malformed = (command) => `Unrecognized Superset response for ${command}`;

/** Hosts are listed in parallel: one asleep VM should cost one timeout, not one per host. */
const HOST_CONCURRENCY = 4;

/**
 * How long a host list is reused before asking again.
 *
 * `hosts list` is a cloud round-trip — measured at ~1.4s, which was the single most expensive
 * call in a poll and by far the least informative: a fleet's machines change when someone buys
 * a laptop, not between ticks. Caching it takes that cost off almost every poll; the price is
 * that a newly-joined host takes up to this long to appear, which is nothing next to the time
 * it takes a person to open a workspace on it.
 */
const HOSTS_TTL_MS = 30_000;

/** @type {{at: number, result: {ok: boolean, error: string | null, hosts: object[]}} | null} */
let hostsCache = null;
let hostsLookup = null;

/** Run `tasks` with at most `limit` in flight, preserving input order in the output. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The machines this account can see, from a cache no older than HOSTS_TTL_MS.
 *
 * A failure is never cached: a host list that went missing because the network blinked should
 * be retried on the next tick, not remembered as gospel for half a minute.
 */
export async function listHosts({ fresh = false, background = false } = {}) {
  if (!fresh && hostsCache && Date.now() - hostsCache.at < HOSTS_TTL_MS) return hostsCache.result;
  if (hostsLookup) return hostsLookup;
  hostsLookup = (async () => {
    const res = await runCli(['hosts', 'list'], { background });
    if (!res.ok) return { ok: false, error: res.error, hosts: [] };
    const rows = rowsOf(res.data, 'hosts');
    if (!rows) return { ok: false, error: malformed('hosts list'), hosts: [] };
    const result = { ok: true, error: null, hosts: rows };
    hostsCache = { at: Date.now(), result };
    return result;
  })().finally(() => {
    hostsLookup = null;
  });
  return hostsLookup;
}

/**
 * Which host this process is sitting on, from the local host service.
 *
 * Only used to tell local from remote — for the transcripts source, which can only read files
 * on this machine, and for the badge that says which box a workspace is really on. Null when
 * the service is not up, and everything then behaves as if every workspace were remote, which
 * costs a badge rather than a room.
 */
let localHost = null;
let localHostName = null;
let localHostConfirmed = false;
let localHostLookup = null;
let localHostNameRefreshAt = -Infinity;

/**
 * Workspace rows confirm identity. Status can provide a provisional ID on an empty host,
 * but it must be retried after a workspace appears. Concurrent callers share the lookup.
 */
export function localHostId() {
  if (localHostConfirmed) return Promise.resolve(localHost);
  if (localHostLookup) return localHostLookup;
  localHostLookup = (async () => {
    const res = await call({
      proc: 'workspace.list',
      input: undefined,
      cli: ['workspaces', 'list', '--local'],
    });
    const rows = res.ok ? rowsOf(res.data, 'workspaces') : null;
    const confirmed = rows?.find((w) => typeof w.hostId === 'string' && w.hostId)?.hostId;
    if (confirmed) {
      if (localHost !== confirmed) localHostName = null;
      localHost = confirmed;
      localHostConfirmed = true;
    } else {
      // An empty startup can report an unregistered ID. It is provisional until a workspace
      // confirms it, and an unavailable host cannot supply even a provisional identity.
      const status = await runCli(['status']);
      localHost =
        status.ok && status.data?.running === true && typeof status.data?.hostId === 'string'
          ? status.data.hostId
          : null;
    }
    if (localHost) {
      refreshLocalHostName();
    }
    return localHost;
  })().finally(() => {
    localHostLookup = null;
  });
  return localHostLookup;
}

function refreshLocalHostName() {
  const update = (known) => {
    const name = known.hosts.find((host) => host.id === localHost)?.name;
    if (name) localHostName = name;
  };
  if (hostsCache) update(hostsCache.result);
  if (!hasBackgroundCliCapacity() || Date.now() - localHostNameRefreshAt < HOSTS_TTL_MS) return;
  localHostNameRefreshAt = Date.now();
  void listHosts({ background: true })
    .then(update)
    .catch(() => {});
}

/**
 * What this machine is CALLED, which only the viewer's own instance can say.
 *
 * With one instance per host, every agent is local to whichever server reported it, so
 * `remote` is a fact about the reporter and not about the viewer. The browser needs to know
 * which host is home before it can tell which rooms are away — see hostChip in public/app.js.
 */
export const localHostNameOf = () => localHostName;

/**
 * Whether a workspace on this host can take the fast path.
 *
 * The host service only knows its OWN machine — `workspace.list` there ignores a hostId and
 * `terminal.*` only holds this box's PTYs — so the fast path is offered for local work and
 * nothing else. Remote hosts go through the CLI, which reaches them via the cloud relay.
 */
async function isLocalHost(hostId) {
  if (!hostId) return true; // no host named means "here", which is what the CLI would assume
  return hostId === (await localHostId());
}

/**
 * `online` is the host service's own word for whether it can be reached at all. Polling a
 * host that has said no costs a full CALL_TIMEOUT_MS per tick and returns nothing, so those
 * are skipped — but only on an explicit no. An unrecognised value is treated as reachable,
 * because losing half the fleet to a renamed field is much worse than one wasted timeout.
 */
const isOnline = (host) => host.online !== 'no' && host.online !== false;

/**
 * Every live workspace on every host you can see, each tagged with the host it lives on.
 *
 * Partial failure is normal here and must not be fatal: a VM asleep, a host mid-update or a
 * network that dropped takes out that host's rooms and nothing else. `ok` therefore means
 * "at least one host answered", and `error` reports whoever did not while the rest are drawn.
 */
const metadataByHost = new Map();
const METADATA_TTL_MS = 5 * 60_000;
let metadataRefresh = null;
let metadataRefreshAt = -Infinity;

function discoveryResult({
  ok,
  error = null,
  workspaces = [],
  authoritativeHostIds = [],
  incompleteHostIds = [],
  hostListComplete = false,
}) {
  const now = Date.now();
  for (const [hostId, held] of metadataByHost) {
    if (now - held.at > METADATA_TTL_MS) metadataByHost.delete(hostId);
  }
  const known = new Map();
  for (const held of metadataByHost.values()) for (const row of held.rows) known.set(row.id, row);
  for (const row of workspaces) known.set(row.id, row);
  return {
    ok,
    error,
    workspaces,
    knownWorkspaces: [...known.values()],
    authoritativeHostIds,
    incompleteHostIds,
    hostListComplete,
  };
}

async function listLocalWorkspaces() {
  const res = await call({
    proc: 'workspace.list',
    input: undefined,
    cli: ['workspaces', 'list', '--local'],
  });
  if (!res.ok)
    return discoveryResult({
      ok: false,
      error: res.error,
      incompleteHostIds: localHost ? [localHost] : [],
    });
  const rows = rowsOf(res.data, 'workspaces');
  if (!rows)
    return discoveryResult({
      ok: false,
      error: malformed('workspaces list'),
      incompleteHostIds: localHost ? [localHost] : [],
    });
  const confirmed = rows.find((row) => typeof row.hostId === 'string' && row.hostId)?.hostId;
  if (confirmed) {
    if (localHost !== confirmed) localHostName = null;
    localHost = confirmed;
    localHostConfirmed = true;
    refreshLocalHostName();
  }
  const workspaces = rows.map((row) => ({
    ...row,
    hostId: row.hostId ?? localHost,
    hostName: row.hostName ?? localHostName,
  }));
  if (localHost) metadataByHost.set(localHost, { at: Date.now(), rows: workspaces });
  return discoveryResult({
    ok: true,
    workspaces,
    authoritativeHostIds: localHost ? [localHost] : [],
  });
}

async function discoverFleet({ background = false } = {}) {
  const known = await listHosts({ background });
  if (!known.ok || !known.hosts.length) {
    if (known.ok) {
      for (const id of metadataByHost.keys()) if (id !== localHost) metadataByHost.delete(id);
    }
    if (background)
      return discoveryResult({ ok: false, error: known.error, hostListComplete: known.ok });
    const local = await listLocalWorkspaces();
    return {
      ...local,
      error: local.error || (known.ok ? null : known.error),
      hostListComplete: known.ok,
      incompleteHostIds: [
        ...new Set([
          ...local.incompleteHostIds,
          ...[...metadataByHost.keys()].filter((id) => !local.authoritativeHostIds.includes(id)),
        ]),
      ],
    };
  }
  const visible = new Set(known.hosts.map((host) => host.id));
  for (const id of metadataByHost.keys())
    if (id !== localHost && !visible.has(id)) metadataByHost.delete(id);
  const offline = known.hosts.filter((host) => !isOnline(host));
  const reachable = known.hosts.filter(
    (host) => isOnline(host) && (!background || host.id !== localHost),
  );
  const perHost = await mapLimit(reachable, HOST_CONCURRENCY, async (host) => {
    const res = await call({
      proc: !background && (await isLocalHost(host.id)) ? 'workspace.list' : null,
      input: undefined,
      cli: ['workspaces', 'list', '--host', host.id],
      background,
    });
    if (!res.ok) return { host, error: res.error, rows: [] };
    const rows = rowsOf(res.data, 'workspaces');
    if (!rows) return { host, error: malformed('workspaces list'), rows: [] };
    return {
      host,
      error: null,
      rows: rows.map((row) => ({ ...row, hostId: row.hostId ?? host.id, hostName: host.name })),
    };
  });
  const answered = perHost.filter((result) => !result.error);
  const failed = perHost.filter((result) => result.error);
  for (const { host, rows } of answered) metadataByHost.set(host.id, { at: Date.now(), rows });
  const seen = new Map();
  for (const { rows } of answered)
    for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  const problems = failed.map(({ host, error }) => `${host.name}: ${error}`);
  return discoveryResult({
    ok: answered.length > 0,
    error: problems.length
      ? `unreachable: ${problems.join('; ')}`
      : answered.length
        ? null
        : 'no hosts online',
    workspaces: [...seen.values()],
    authoritativeHostIds: answered.map(({ host }) => host.id),
    hostListComplete: true,
    incompleteHostIds: [...offline.map((host) => host.id), ...failed.map(({ host }) => host.id)],
  });
}

/**
 * Host scope never waits for a remote workspace read. Background metadata preserves remote
 * IDs for relationship evidence, but only workspaces contains current authoritative rooms.
 * Completeness is per host: an unavailable host is different from a successful empty list.
 */
export async function listWorkspaces({ scope = 'fleet' } = {}) {
  if (scope !== 'host') return discoverFleet();
  const local = await listLocalWorkspaces();
  if (
    hasBackgroundCliCapacity() &&
    !metadataRefresh &&
    Date.now() - metadataRefreshAt >= HOSTS_TTL_MS
  ) {
    metadataRefreshAt = Date.now();
    metadataRefresh = discoverFleet({ background: true })
      .catch(() => {})
      .finally(() => {
        metadataRefresh = null;
      });
  }
  return local;
}

export async function listTerminals(workspaceId, hostId) {
  const args = ['terminals', 'list', '--workspace', workspaceId];
  if (hostId) args.push('--host', hostId);
  const res = await call({
    proc: (await isLocalHost(hostId)) ? 'terminal.list' : null,
    input: { workspaceId },
    cli: args,
  });
  if (!res.ok) return { ok: false, error: res.error, sessions: [] };
  const sessions = rowsOf(res.data, 'sessions', 'terminalId');
  if (!sessions) return { ok: false, error: malformed('terminals list'), sessions: [] };
  return { ok: true, sessions };
}

export async function readTerminal(workspaceId, terminalId, hostId, maxLines) {
  const args = ['terminals', 'read', '--workspace', workspaceId, '--terminal', terminalId];
  if (hostId) args.push('--host', hostId);
  if (maxLines) args.push('--max-lines', String(maxLines));
  // `terminal.snapshot` is the procedure `terminals read` calls: same screen, same cols/rows.
  const res = await call({
    proc: (await isLocalHost(hostId)) ? 'terminal.snapshot' : null,
    input: { workspaceId, terminalId },
    cli: args,
  });
  if (!res.ok) return { ok: false, error: res.error, text: '' };
  if (typeof res.data?.text !== 'string')
    return { ok: false, error: malformed('terminals read'), text: '' };
  return {
    ok: true,
    text: res.data.text,
    cols: res.data?.cols,
    rows: res.data?.rows,
  };
}

/**
 * What each agent's own hooks have told the host service, keyed by terminal id.
 *
 * Every Claude Code and Codex session Superset launches has lifecycle hooks wired in — a
 * prompt submitted, a turn finished, a permission prompt, a sub-agent started or stopped —
 * and each one POSTs to the host service, which keeps one binding per terminal:
 *
 *     { terminalId, workspaceId, agentId, agentSessionId, startedAt, lastEventAt,
 *       lastEventType: 'Start' | 'Stop' | 'PermissionRequest' | 'Failed' | 'Attached',
 *       subagents?: [{ id, agentType, startedAt, lastEventAt }] }     (only while live)
 *
 * This is the same state that drives the working and permission indicators in the desktop
 * app, and it is exact where a screen is a guess: the agent said so, at the moment it happened.
 * It is `terminalAgents.list` on the host service and nothing else — no CLI command prints it
 * and no MCP tool returns it — so it only covers THIS MACHINE, and an empty map here is the
 * normal answer on the CLI path. Everything that reads it treats it as a second opinion.
 *
 * Two limits, both from the host's own source: an interrupt fires no hook, so a binding can
 * sit at `Start` after a human hit escape; and a sub-agent that goes quiet is dropped after
 * ten minutes. Both are why the screen is still read alongside it — see lib/world.js.
 *
 * @returns {Promise<Map<string, object>>} terminalId → binding; empty when unavailable
 */
export async function listTerminalAgents() {
  const res = await callDirectOnly('terminalAgents.list', undefined);
  const rows = Array.isArray(res.data) ? res.data : [];
  return new Map(rows.filter((b) => b?.terminalId).map((b) => [b.terminalId, b]));
}

/**
 * The Superset task a workspace was opened for, by id, remembered once fetched.
 *
 * A task's title is the one-line summary of the work that exists before the agent has said a
 * word, and it is the same on every host, so it is the fallback for a session whose transcript
 * is on another machine. `tasks get` is a cloud round-trip, so an id is fetched once and kept;
 * a failure is retried, but not every tick.
 *
 * @type {Map<string, {at: number, task: {slug: string | null, title: string} | null}>}
 */
const tasksById = new Map();
const TASK_RETRY_MS = 5 * 60_000;
const TASK_FETCHES_PER_TICK = 2;

/**
 * @param {string[]} ids every taskId in the fleet this tick
 * @returns {Promise<Map<string, {slug: string | null, title: string}>>} the ones known so far
 */
export async function lookupTasks(ids) {
  const now = Date.now();
  const wanted = [...new Set(ids.filter(Boolean))].filter((id) => {
    const held = tasksById.get(id);
    return !held || (!held.task && now - held.at > TASK_RETRY_MS);
  });
  await mapLimit(wanted.slice(0, TASK_FETCHES_PER_TICK), TASK_FETCHES_PER_TICK, async (id) => {
    const res = await runCli(['tasks', 'get', id]);
    const row = res.ok ? (res.data?.task ?? res.data) : null;
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    tasksById.set(id, {
      at: now,
      task: title ? { slug: typeof row.slug === 'string' ? row.slug : null, title } : null,
    });
  });
  const known = new Map();
  for (const id of ids) {
    const task = tasksById.get(id)?.task;
    if (task) known.set(id, task);
  }
  return known;
}

/** A broken CLI must not hold server startup open forever. */
export async function cliVersion({ spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(CLI, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (version) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(version);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      out = (out + data).slice(0, 1024);
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out.trim() || null : null));
  });
}
