// How this tool actually talks to Superset — and why there are two ways.
//
// `superset` is not a script. It is a 75 MB compiled Bun binary, so every invocation loads
// that image and boots a JavaScript runtime: measured at ~480ms and ~130MB resident, to do
// work that takes ONE MILLISECOND. A poll that reads twenty-five terminals pays that toll
// forty-six times, which is what made a three-host fleet cost six seconds and a gigabyte of
// transient memory per tick. Almost none of that was reading anything.
//
// Underneath, the CLI is a thin client for a tRPC server the host service already runs on
// loopback. Its address and token sit in `~/.superset/host/<org>/manifest.json`, which is how
// the CLI finds them too. Talking to it directly costs a `fetch`:
//
//     superset workspaces list          483 ms, one process, ~130 MB
//     workspace.list over tRPC            1 ms, no process,  no memory
//
// So the fast path is used wherever it reaches, and the CLI is kept for everything else.
//
// WHAT THIS DOES NOT CHANGE. lib/superset.js's header explains that the fleet is read through
// the CLI rather than the host's sqlite so that this tool can only ever show a state the
// orchestrator itself could have observed. That still holds: this is the same server the CLI
// asks, answering the same procedures with the same rows — one layer down, not a second store.
// Field-for-field parity against `workspaces list` was checked and differs in one place, the
// `tags` column, which arrives as an array here and a string there and is unused either way.
//
// WHAT IT COSTS. `/trpc/*` is a private interface. Procedure names and the superjson envelope
// are internal to Superset and may change in any release, with no deprecation owed to us. That
// is the whole reason the CLI path stays: the fast path is probed once, and anything it cannot
// answer — every remote host, and the cloud's own `hosts list` — falls back to spawning the
// real command, which is a supported contract and will keep working.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readHostManifest } from './manifest.js';

const CLI = process.env.SUPERSET_CLI || 'superset';

// A single terminal read is ~0.5s. Ten seconds means the host is wedged, not slow, and we
// would rather drop one tick's worth of a terminal than stall the whole poll behind it.
const CALL_TIMEOUT_MS = 10_000;

/** The fast path is loopback; a second is already a wedged host service, not a slow one. */
const DIRECT_TIMEOUT_MS = 4_000;

/**
 * How many `superset` PROCESSES may be alive at once, enforced here rather than by the caller.
 *
 * This is the only real resource in the whole tool: ~130 MB a piece, so twelve at once is a
 * genuine gigabyte of pressure on something that runs as a login service. Rationing it at the
 * spawn rather than at the poll is what lets the world above ask for as much concurrency as it
 * likes — direct calls, which cost nothing, are then not throttled to protect a cost they do
 * not have.
 *
 * Twelve is measured rather than chosen: on a 21-agent fleet whose remote half is the only
 * thing still spawning anything, the median poll runs 7.9s at eight, 5.8s at twelve and 5.2s
 * at sixteen. The curve has flattened by twelve and the memory has not, so that is where the
 * default sits.
 */
const CLI_MAX_INFLIGHT = Number(process.env.AGENT_FLEET_CLI_INFLIGHT ?? 12);

let cliInFlight = 0;
const cliWaiting = [];

async function acquireCliSlot() {
  if (cliInFlight < CLI_MAX_INFLIGHT) {
    cliInFlight += 1;
    return;
  }
  await new Promise((resolve) => cliWaiting.push(resolve));
  cliInFlight += 1;
}

function releaseCliSlot() {
  cliInFlight -= 1;
  cliWaiting.shift()?.();
}

/**
 * The CLI occasionally prefixes JSON with an update notice or a warning line. Rather than
 * fail the whole poll on chrome we did not ask for, take the outermost JSON value.
 */
function extractJson(stdout) {
  const start = stdout.search(/[[{]/);
  if (start === -1) return null;
  const open = stdout[start];
  const end = stdout.lastIndexOf(open === '[' ? ']' : '}');
  if (end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Run the real `superset` binary. Slow and heavy, and correct everywhere. */
export async function runCli(args) {
  await acquireCliSlot();
  try {
    return await new Promise((resolve) => {
      let child;
      try {
        child = spawn(CLI, [...args, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, error: `timed out after ${CALL_TIMEOUT_MS}ms` });
      }, CALL_TIMEOUT_MS);

      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => finish({ ok: false, error: err.message }));
      child.on('close', (code) => {
        if (code !== 0) {
          finish({ ok: false, error: `superset exited with status ${code ?? 'unknown'}` });
          return;
        }
        const data = extractJson(stdout);
        if (data === null) {
          finish({ ok: false, error: stderr.trim() || `exit ${code} with no JSON on stdout` });
          return;
        }
        finish({ ok: true, data });
      });
    });
  } finally {
    releaseCliSlot();
  }
}

/** superjson's encoding of a procedure that takes no argument at all. */
const NO_INPUT = { json: null, meta: { values: ['undefined'], v: 1 } };

// Private procedures can change independently of the CLI. A new payload shape must use
// the fallback, not silently become an empty list of workspaces or terminals.
const directShapes = {
  'workspace.list': (value) => Array.isArray(value) || Array.isArray(value?.workspaces),
  'terminal.list': (value) => Array.isArray(value?.sessions),
  'terminal.snapshot': (value) => typeof value?.text === 'string',
  'terminalAgents.list': (value) => Array.isArray(value),
};

/** @type {{endpoint: string, authToken: string} | null} */
let direct = null;
/** @type {Promise<boolean> | null} */
let probing = null;
let directNote = 'not probed';

/**
 * Can we reach the host service directly? Asked once and remembered.
 *
 * The probe is a real call rather than a ping: a manifest can name a port that something else
 * now holds, or a service too old to know the procedure, and both of those must read as "use
 * the CLI" rather than as a fleet with no workspaces in it.
 */
export function useDirect() {
  if (probing) return probing;
  probing = (async () => {
    if (process.env.SUPERSET_TRANSPORT === 'cli') {
      directNote = 'using the superset CLI by configuration';
      return false;
    }
    const { manifest, reason } = await readHostManifest(
      process.env.SUPERSET_HOME_DIR || join(homedir(), '.superset'),
    );
    if (!manifest) {
      directNote = `${reason}; using the superset CLI`;
      return false;
    }
    const probe = await callDirect('workspace.list', undefined, manifest);
    if (!probe.ok) {
      directNote = `host service did not answer (${probe.error}) — using the superset CLI`;
      return false;
    }
    direct = manifest;
    directNote = `host service at ${manifest.endpoint}`;
    return true;
  })();
  return probing;
}

/** One line for the startup banner and /api/health, so the transport in use is never a guess. */
export const transportNote = () => directNote;

/**
 * One tRPC call over loopback.
 *
 * Errors are returned rather than thrown, in the same shape `runCli` uses, so a caller can
 * fall back to the CLI without knowing which transport disappointed it.
 */
async function callDirect(proc, input, manifest = direct) {
  if (!manifest) return { ok: false, error: 'no direct transport' };
  const query = new URLSearchParams({
    input: JSON.stringify(input === undefined ? NO_INPUT : { json: input }),
  });
  let res;
  try {
    res = await fetch(`${manifest.endpoint}/trpc/${proc}?${query}`, {
      headers: { authorization: `Bearer ${manifest.authToken}` },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) return { ok: false, error: `${proc}: HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `${proc}: ${res.status} with no JSON` };
  }
  if (body?.error) return { ok: false, error: body.error?.json?.message ?? `${proc} failed` };
  // superjson wraps the payload; `data.json` is the value the CLI would have printed.
  if (!body?.result?.data || !Object.hasOwn(body.result.data, 'json')) {
    return { ok: false, error: `${proc}: unrecognized host response` };
  }
  const data = body.result.data.json;
  if (directShapes[proc] && !directShapes[proc](data)) {
    return { ok: false, error: `${proc}: unrecognized host data` };
  }
  return { ok: true, data };
}

/**
 * A procedure only the host service has — no `superset` command prints it — so there is no
 * CLI to fall back to. Off the fast path it simply answers "not available", and the caller
 * has to have a plan for that; this is the shape of every answer that only the local host
 * service can give, and the reason those stay optional extras rather than sources of truth.
 */
export async function callDirectOnly(proc, input) {
  if (!(await useDirect())) return { ok: false, error: 'no direct transport' };
  return callDirect(proc, input);
}

/**
 * Ask the host service if it can answer, and the CLI otherwise.
 *
 * `cli` is the argv the real command would need; `proc`/`input` the equivalent tRPC call. A
 * direct call that fails for its own reasons still falls through to the CLI, so a procedure
 * renamed by a Superset update costs a slow poll rather than a blank world.
 */
export async function call({ proc, input, cli }) {
  if (proc && (await useDirect())) {
    const res = await callDirect(proc, input);
    if (res.ok) return res;
  }
  return runCli(cli);
}
