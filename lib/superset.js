// Thin wrapper over the `superset` CLI.
//
// Superset Agent Fleet reads the fleet through the same CLI the orchestrator drives, rather than
// through the host's sqlite or the cloud API. That is deliberate: it can then only ever
// display a state the orchestrator could itself have observed, so a disagreement between
// the picture and the agents is a bug in this tool and not a second source of truth.

import { spawn } from 'node:child_process';

const CLI = process.env.SUPERSET_CLI || 'superset';

// A single terminal read is ~0.5s. Ten seconds means the host is wedged, not slow, and we
// would rather drop one tick's worth of a terminal than stall the whole poll behind it.
const CALL_TIMEOUT_MS = 10_000;

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

function runCli(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLI, [...args, '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
      const data = extractJson(stdout);
      if (data === null) {
        finish({
          ok: false,
          error: stderr.trim() || `exit ${code} with no JSON on stdout`,
        });
        return;
      }
      finish({ ok: true, data });
    });
  });
}

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

export async function listWorkspaces() {
  const res = await runCli(['workspaces', 'list']);
  if (!res.ok) return { ok: false, error: res.error, workspaces: [] };
  const rows = Array.isArray(res.data) ? res.data : (res.data.workspaces ?? []);
  return { ok: true, workspaces: rows };
}

export async function listTerminals(workspaceId) {
  const res = await runCli(['terminals', 'list', '--workspace', workspaceId]);
  if (!res.ok) return { ok: false, error: res.error, sessions: [] };
  return { ok: true, sessions: res.data.sessions ?? [] };
}

export async function readTerminal(workspaceId, terminalId, maxLines) {
  const args = ['terminals', 'read', '--workspace', workspaceId, '--terminal', terminalId];
  if (maxLines) args.push('--max-lines', String(maxLines));
  const res = await runCli(args);
  if (!res.ok) return { ok: false, error: res.error, text: '' };
  return {
    ok: true,
    text: res.data.text ?? '',
    cols: res.data.cols,
    rows: res.data.rows,
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
