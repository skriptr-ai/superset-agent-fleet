// The third way a message can be known: because the harness wrote down the call it made.
//
// The screen parser assumes an orchestrator drives its fleet by typing `superset` at a shell,
// so the command — and the uuid in it — passes through the terminal on its way out. A Claude
// orchestrator with the Superset MCP server connected does no such thing. It calls
// `mcp__superset__terminals_send` directly, and Claude Code renders that as
//
//     ⏺ Calling superset…
//     Called superset 2 times
//
// and nothing else. The workspace id, the message and the fact that it was a send at all are
// absent from the screen — not elided, not scrolled off, never written there. A real
// orchestration of six workers ran entirely this way and appeared as no orchestrator at all.
//
// Claude Code does, however, keep a complete JSONL transcript of its own session under
// `~/.claude/projects/<cwd with every non-alphanumeric turned into a dash>/`, one record per
// turn, each `tool_use` block carrying the arguments verbatim. That file is the same class of
// evidence as the screen — the agent's own record of what it did — except complete. Reading it
// is what makes an MCP-driven orchestrator visible, and it is exact where the screen was
// best-effort: real ids, full message text, real timestamps.
//
// Only Claude is read here. Codex writes its commands into the normal terminal buffer with a
// thousand lines of scrollback behind them, which the screen parser already recovers; its
// transcripts are filed by date rather than by working directory, so finding the one belonging
// to a workspace would mean opening all of them.
//
// TWO WAYS AN ORCHESTRATOR DRIVES, and both are in here.
//
// The obvious one is the Superset MCP server: `mcp__superset__terminals_send` with the
// workspace id right there in the arguments. The other is a shell — `superset workspaces
// create …` run through the Bash tool — and it is at least as common, because it is what the
// CLI is for and what a loop over four issues naturally looks like.
//
// A shell orchestrator was invisible here, and doubly so. Its calls are Bash blocks, which
// this file used to skip for not being an `mcp__superset__*` name. And its targets are usually
// SHELL VARIABLES — `--workspace "$ws"`, `--task "${UUID[$n]}"` — resolved in a shell nobody
// sees, so even reading the command text finds no id to point at.
//
// The answer is that the harness records the RESULT too. `superset workspaces create --json`
// prints the new workspace, and Claude files that output as a `tool_result` block alongside
// the call that produced it. So a spawn whose target existed nowhere in the command is named
// exactly once, in its own output, and that is where it is read from.
//
// This is why only COMMANDS are allowed to name a target from their result. `workspaces list`
// returns every workspace there is; taking ids from that would elect an orchestrator out of a
// status sweep, which is the trap #recordCall in world.js is built to avoid.

import { readdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** One oversized or corrupt line should cost that line, not the run. */
const MAX_LINE = 1024 * 1024;

/**
 * How much of a transcript counts as history the first time it is seen.
 *
 * A file is read forward from wherever we left off, but the first sighting has no such mark —
 * the session may have been running for hours before this process started. Its tail is read in
 * and emitted as REPLAY, which is what puts a bartender behind the bar with its workers on
 * tick one instead of waiting for the next message. Counts are rebuilt from source on every
 * start (see World's links), so this doubles nothing; the cap is only so a very long session
 * does not pull megabytes through on the first poll.
 */
const BACKFILL_BYTES = 4 * 1024 * 1024;

/**
 * The MCP calls that say something about who is running whom, mapped to the same verbs the
 * screen parser produces. `send` and `create` are COMMANDS and elect an orchestrator; `read`
 * is filed separately, because looking at a screen is what a status sweep does.
 *
 * `workspaces_create` is deliberately absent: the workspace it makes is named in the RESULT,
 * not the arguments, so there is no target to attribute the call to.
 */
const VERBS = new Map([
  ['mcp__superset__terminals_send', 'send'],
  ['mcp__superset__agents_create', 'create'],
  ['mcp__superset__terminals_create', 'create'],
  ['mcp__superset__terminals_read', 'read'],
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SHAPE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * A workspace id in a command's OUTPUT, found by the key that names it rather than by shape.
 *
 * Scraping bare uuids out of the text does not work, and fails in a way that looks like it is
 * working. Superset paths are full of them — a worktree lives under its PROJECT id, and this
 * harness writes scratch files under a SESSION id — so a result that merely mentions a path
 * yields two or three confident, wrong answers. Measured against a real transcript that is
 * exactly what happened: three targets recovered, every one a project or session id, not one
 * of them a workspace.
 *
 * `--json` output names the thing properly, so read the name: a `workspaceId` field, or the
 * `id` of the `workspace` object that `workspaces create` returns.
 */
const RESULT_WORKSPACE_RES = [
  new RegExp(`"workspaceId"\\s*:\\s*"(${UUID_SHAPE})"`, 'g'),
  new RegExp(`"workspace"\\s*:\\s*\\{[^{}]*?"id"\\s*:\\s*"(${UUID_SHAPE})"`, 'g'),
];

/** `superset terminals send …`, `superset ws create …`, and the abbreviations for both. */
const SHELL_CALL_RE = /superset\s+(terminals|term|workspaces|ws|agents)\s+([a-z]+)/;

/** A literal id typed into the command, which needs no result to resolve it. */
const SHELL_WORKSPACE_RE =
  /--workspace[= ]+["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/**
 * Which shell verbs mean what, in the same vocabulary the MCP names map to.
 *
 * `read` is here so a polling loop is filed as watching rather than driving; `list` and `get`
 * are deliberately absent, because their output names workspaces the caller merely looked at.
 */
const SHELL_VERBS = new Map([
  ['send', 'send'],
  ['create', 'create'],
  ['read', 'read'],
]);

/**
 * How many ids a single command's output may name.
 *
 * A create returns one workspace. A cap keeps a surprising result — an error listing every
 * workspace, a verb that grew a `--all` — from turning one call into a dozen attributions.
 */
const MAX_IDS_FROM_RESULT = 2;

/**
 * Claude Code files a session under its working directory with every character that is not a
 * letter or a digit replaced by a dash, so `/Users/me/.superset/worktrees/x/y` becomes
 * `-Users-me--superset-worktrees-x-y`.
 *
 * This is a guess about another tool's internals, so it is never trusted on its own: every
 * record carries the `cwd` it was written in, and a record whose cwd is not this workspace's
 * worktree is dropped. A changed scheme therefore costs us the transcripts, not the truth.
 */
export const projectSlug = (path) => path.replace(/[^A-Za-z0-9]/g, '-');

export class Transcripts {
  /** @param {string | null} root where Claude Code keeps its per-project sessions; null disables */
  constructor(root) {
    this.root = root;
    /**
     * @type {Map<string, {offset: number, pending: Buffer}>} transcript path → how far we have
     * read it, and the tail of a record whose other half has not been written yet
     */
    this.files = new Map();
    this.error = null;
  }

  /**
   * Every superset call the given workspaces' agents have made since the last read.
   *
   * @param {{id: string, worktreePath?: string}[]} workspaces the live fleet
   * @returns {Promise<{at: number, verb: string, fromId: string, toId: string,
   *   terminalId: string | null, text: string | null, replay: boolean}[]>} in time order
   */
  async read(workspaces) {
    if (!this.root) return [];
    const messages = [];
    let error = null;
    for (const ws of workspaces) {
      if (!ws.worktreePath) continue;
      const dir = join(this.root, projectSlug(ws.worktreePath));
      let names;
      try {
        names = await readdir(dir);
      } catch (err) {
        // No directory is the normal state for a workspace whose agent is not Claude, or has
        // not written a turn yet. It must not look like a failure.
        if (err?.code !== 'ENOENT') error = err.message;
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          messages.push(...(await this.#readFile(join(dir, name), ws)));
        } catch (err) {
          error = err.message;
        }
      }
    }
    this.error = error;
    // Two sessions in one workspace, or two workspaces entirely, interleave; the world wants
    // one ordered stream rather than one file's worth at a time.
    return messages.sort((a, b) => a.at - b.at);
  }

  /** New records at the end of one transcript, or its tail if this is the first sighting. */
  async #readFile(path, ws) {
    const info = await stat(path);
    let state = this.files.get(path);
    const fresh = !state;
    if (!state) {
      // Truncated to the last few megabytes, and only on the first sighting: what came before
      // is history we would read once and then never again.
      state = {
        offset: Math.max(0, info.size - BACKFILL_BYTES),
        pending: EMPTY,
        awaiting: new Map(),
      };
      this.files.set(path, state);
    } else if (info.size < state.offset) {
      // Rotated or rewritten underneath us: the offset now points past the end, or into the
      // middle of a different file.
      state.offset = 0;
      state.pending = EMPTY;
    }
    if (info.size === state.offset) return [];
    // A backfill that had to skip the front of the file starts mid-record, so the first line
    // it reads is the tail of a turn we never saw.
    const partialFirstLine = fresh && state.offset > 0;

    const handle = await open(path, 'r');
    let chunk;
    try {
      const length = info.size - state.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      state.offset += bytesRead;
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => {});
    }

    // Carried over as BYTES rather than as text. A read stops at whatever the file's size was
    // when we stat'd it, which is quite possibly the middle of a record and therefore the
    // middle of a character; decoding there would leave a replacement character in the message
    // and lose the whole line to a parse error once its other half arrived.
    const combined = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
    const lastNewline = combined.lastIndexOf(NEWLINE);
    // Whatever follows the last newline is not a record yet.
    const rest = lastNewline === -1 ? combined : combined.subarray(lastNewline + 1);
    state.pending = rest.length > MAX_LINE ? EMPTY : Buffer.from(rest);
    if (lastNewline === -1) return [];

    const lines = combined.subarray(0, lastNewline).toString('utf8').split('\n');
    if (partialFirstLine) lines.shift();

    const out = [];
    // A call and its result land in different records, and quite possibly different reads, so
    // what is still waiting to be answered outlives the chunk it arrived in.
    if (!state.awaiting) state.awaiting = new Map();
    for (const line of lines) {
      for (const call of callsIn(line, ws.worktreePath, state.awaiting)) {
        if (call.toId === ws.id) continue; // an agent reading its own screen is not traffic
        out.push({ ...call, fromId: ws.id, replay: fresh });
      }
    }
    return out;
  }
}

/**
 * The superset calls in one transcript record, or none.
 *
 * Nothing in the file is trusted to be well-formed or to belong to us: it is written by
 * another tool, and a record made in a different working directory is a different agent's.
 */
function callsIn(line, worktreePath, awaiting) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_LINE) return [];
  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!row) return [];
  // The slug is a guess; this is the check that makes it safe to have guessed.
  if (row.cwd !== worktreePath) return [];
  const content = row.message?.content;
  if (!Array.isArray(content)) return [];
  const at = Date.parse(row.timestamp);
  const when = Number.isFinite(at) ? at : Date.now();

  // A result arrives in a later record than the call it answers, in a `user` row that carries
  // the id of the call. This is where a shell spawn finally names the worker it made.
  if (row.type === 'user') {
    const calls = [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const pending = awaiting.get(block.tool_use_id);
      if (!pending) continue;
      awaiting.delete(block.tool_use_id);
      const printed =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      if (typeof printed !== 'string') continue;
      const seen = new Set();
      for (const re of RESULT_WORKSPACE_RES) {
        re.lastIndex = 0;
        for (const found of printed.matchAll(re)) {
          const id = found[1];
          if (id === pending.selfId || seen.has(id)) continue;
          seen.add(id);
          if (seen.size > MAX_IDS_FROM_RESULT) break;
          calls.push({
            at: pending.at,
            verb: pending.verb,
            toId: id,
            terminalId: null,
            text: pending.text,
          });
        }
      }
    }
    return calls;
  }

  if (row.type !== 'assistant') return [];
  const calls = [];
  for (const block of content) {
    if (block?.type !== 'tool_use') continue;

    // The shell route. Its target is usually a variable, so the call is parked until its own
    // output names what it made — see the note at the top of this file.
    if (block.name === 'Bash') {
      const command = typeof block.input?.command === 'string' ? block.input.command : '';
      const match = SHELL_CALL_RE.exec(command);
      const verb = match && SHELL_VERBS.get(match[2]);
      if (!verb) continue;
      const literal = SHELL_WORKSPACE_RE.exec(command)?.[1];
      if (literal) {
        calls.push({ at: when, verb, toId: literal, terminalId: null, text: null });
        continue;
      }
      // Only a COMMAND may name its target from its output. A read or a list would otherwise
      // hand this agent every workspace it happened to look at.
      if (verb !== 'create' && verb !== 'send') continue;
      awaiting.set(block.id, { at: when, verb, text: null, selfId: null });
      continue;
    }

    const verb = VERBS.get(block.name);
    if (!verb) continue;
    const input = block.input;
    const toId = typeof input?.workspaceId === 'string' ? input.workspaceId : null;
    if (!toId || !UUID_RE.test(toId)) continue;
    // `text` is what a send carries; `prompt` is what a spawn carries. Both are the words
    // that reached the worker, which is what a speech bubble wants.
    const said = typeof input.text === 'string' ? input.text : input.prompt;
    calls.push({
      at: when,
      verb,
      toId,
      terminalId: typeof input.terminalId === 'string' ? input.terminalId : null,
      text: typeof said === 'string' && said ? said.slice(0, 2000) : null,
    });
  }
  return calls;
}
