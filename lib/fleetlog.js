// The other way a message can be known: because the orchestrator wrote it down.
//
// Everything else here infers traffic from terminal screens, which fails in a way no parser
// can fix. An orchestrator with several workers loops over them —
// `superset terminals send --workspace "$ws"` — and the uuid is resolved in a shell nobody
// ever sees. The screen carries the literal characters `"$ws"`, so the message has no
// recipient at all. Not truncated, not scrolled away: absent.
//
// `bin/superset-send` is a drop-in for `superset terminals send` that appends one line per
// message before handing argv to the real CLI. Reading those lines here makes traffic from any
// orchestrator using it exact — sender, recipient and the full text, with no dependence on
// what its harness happened to leave on screen.
//
// This is still only ever a record of what an orchestrator did, written by the orchestrator
// itself as it did it. Screens remain the fallback for anyone not using the wrapper, so the
// view degrades to its old best-effort rather than going blank.

import { open, stat } from 'node:fs/promises';

/** One oversized or corrupt line should cost that line, not the run. */
const MAX_LINE = 64 * 1024;

export class FleetLog {
  /** @param {string | null} path the JSONL the wrapper appends to; null disables the source */
  constructor(path) {
    this.path = path;
    /** How far we have read. New bytes past this are this tick's messages. */
    this.offset = 0;
    /** A trailing partial line: the wrapper appends whole records, but a read can still land
     * mid-write, and half a record must wait for its other half rather than be dropped. */
    this.pending = '';
    this.started = false;
    this.error = null;
  }

  /**
   * Messages appended since the last call.
   *
   * The first call deliberately returns nothing and seeks to the end. The file is a permanent
   * record going back to whenever the wrapper was installed; replaying it on every restart
   * would fire hours of old mail across the room and double every count. Screens are already
   * the source of history — see World's `replay` events — and this is the source of *now*.
   */
  async read() {
    if (!this.path) return [];
    let handle;
    try {
      const info = await stat(this.path);
      // Truncated or rotated underneath us: the offset now points past the end, or into the
      // middle of a different file. Start again from the beginning of the new one.
      if (info.size < this.offset) {
        this.offset = 0;
        this.pending = '';
      }
      if (!this.started) {
        this.started = true;
        this.offset = info.size;
        this.error = null;
        return [];
      }
      if (info.size === this.offset) {
        this.error = null;
        return [];
      }

      handle = await open(this.path, 'r');
      const length = info.size - this.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.error = null;

      const lines = (this.pending + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      // Whatever follows the last newline is not a record yet.
      this.pending = lines.pop() ?? '';
      if (this.pending.length > MAX_LINE) this.pending = '';

      const messages = [];
      for (const line of lines) {
        const message = parseLine(line);
        if (message) messages.push(message);
      }
      return messages;
    } catch (err) {
      // No file yet is the normal state until an orchestrator sends its first message, and it
      // must not look like a failure. Anything else is worth surfacing once.
      if (err?.code === 'ENOENT') {
        this.started = true;
        this.offset = 0;
        this.pending = '';
        this.error = null;
        return [];
      }
      this.error = err.message;
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

/**
 * One line into a message, or null.
 *
 * The file is written by a shell wrapper on someone else's machine, so nothing in it is
 * trusted to be well-formed: a record without both ends of the exchange cannot be drawn and is
 * dropped rather than guessed at.
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_LINE) return null;
  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!row || typeof row !== 'object') return null;
  const fromId = typeof row.from === 'string' ? row.from : null;
  const toId = typeof row.to === 'string' ? row.to : null;
  if (!fromId || !toId || fromId === toId) return null;
  const at = Number.isFinite(row.at) ? row.at : Date.now();
  return {
    at,
    // The same vocabulary the screen parser and the transcript reader speak, so the world
    // files a message the same way whichever of the three knew about it.
    verb: row.kind === 'read' ? 'read' : 'send',
    fromId,
    toId,
    terminalId: typeof row.terminal === 'string' ? row.terminal : null,
    text: typeof row.text === 'string' && row.text ? row.text.slice(0, 2000) : null,
  };
}
