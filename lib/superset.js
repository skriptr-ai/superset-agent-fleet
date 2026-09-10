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
import { call, runCli, useDirect, transportNote } from './transport.js';

const CLI = process.env.SUPERSET_CLI || 'superset';

export { transportNote, useDirect };

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
export async function listHosts({ fresh = false } = {}) {
  if (!fresh && hostsCache && Date.now() - hostsCache.at < HOSTS_TTL_MS) return hostsCache.result;
  const res = await runCli(['hosts', 'list']);
  if (!res.ok) return { ok: false, error: res.error, hosts: [] };
  const rows = Array.isArray(res.data) ? res.data : (res.data.hosts ?? []);
  const result = { ok: true, error: null, hosts: rows };
  hostsCache = { at: Date.now(), result };
  return result;
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

/**
 * Only a SUCCESSFUL answer is remembered. A machine's id never changes, so caching one is
 * free; caching the absence of one is a trap, because the likeliest moment for `status` to
 * fail is the moment this process starts — a login service and the host service come up
 * together — and a remembered null then never gets a second chance.
 *
 * That failure is silent and total rather than partial. With no local host id, `#isLocal` is
 * false for everything: every agent on this very machine is badged as living somewhere else,
 * and the transcripts source is handed an empty list, so an MCP-driven orchestrator stops
 * being seen at all until someone restarts the server. Retrying costs one `status` call per
 * tick, and only until the first one lands.
 */
export async function localHostId() {
  if (localHost) return localHost;
  const res = await runCli(['status']);
  if (res.ok && typeof res.data?.hostId === 'string') {
    localHost = res.data.hostId;
    localHostName = typeof res.data.hostName === 'string' ? res.data.hostName : null;
  }
  return localHost;
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
export async function listWorkspaces() {
  const known = await listHosts();

  // No host list — an old CLI, a cloud outage, or not logged in. Fall back to the local sweep,
  // which is exactly what this tool did before it could see past one machine.
  if (!known.ok || !known.hosts.length) {
    const res = await call({
      proc: 'workspace.list',
      input: undefined,
      cli: ['workspaces', 'list'],
    });
    if (!res.ok) return { ok: false, error: res.error, workspaces: [] };
    const rows = Array.isArray(res.data) ? res.data : (res.data.workspaces ?? []);
    return { ok: true, error: known.ok ? null : known.error, workspaces: rows };
  }

  const reachable = known.hosts.filter(isOnline);
  const perHost = await mapLimit(reachable, HOST_CONCURRENCY, async (host) => {
    const res = await call({
      proc: (await isLocalHost(host.id)) ? 'workspace.list' : null,
      input: undefined,
      cli: ['workspaces', 'list', '--host', host.id],
    });
    if (!res.ok) return { host, error: res.error, rows: [] };
    const rows = Array.isArray(res.data) ? res.data : (res.data.workspaces ?? []);
    // The rows already carry `hostId`; the NAME is what a person recognises, and it lives only
    // in the host list, so it is stapled on here rather than looked up again downstream.
    return {
      host,
      error: null,
      rows: rows.map((w) => ({ ...w, hostId: w.hostId ?? host.id, hostName: host.name })),
    };
  });

  const answered = perHost.filter((r) => !r.error);
  const failed = perHost.filter((r) => r.error);
  if (!answered.length) {
    const why = failed.map((r) => `${r.host.name}: ${r.error}`).join('; ');
    return { ok: false, error: why || 'no hosts online', workspaces: [] };
  }

  // A workspace could in principle be listed by two hosts; the id is the identity, and the
  // world must never draw two rooms for one workspace.
  const seen = new Map();
  for (const { rows } of answered) {
    for (const row of rows) if (!seen.has(row.id)) seen.set(row.id, row);
  }

  // A host that is simply switched off is not trouble — a shut laptop is the normal state of
  // half a fleet — and reporting it would leave the live dot red for as long as it stayed shut,
  // which is how a working tool comes to look broken. Only a host that CLAIMS to be online and
  // then fails to answer is an anomaly, because that is the one that silently costs you rooms.
  const problems = failed.map((r) => `${r.host.name}: ${r.error}`);
  return {
    ok: true,
    error: problems.length ? `unreachable — ${problems.join('; ')}` : null,
    workspaces: [...seen.values()],
  };
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
  return { ok: true, sessions: res.data?.sessions ?? [] };
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
  return {
    ok: true,
    text: res.data?.text ?? '',
    cols: res.data?.cols,
    rows: res.data?.rows,
  };
}

export async function cliVersion() {
  return new Promise((resolve) => {
    const child = spawn(CLI, ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(out.trim() || null));
  });
}
