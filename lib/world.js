// The fleet as a world: who exists, what they are doing, and what just happened between them.
//
// Everything here is a diff against the previous poll. The CLI exposes no message history —
// only current screens — so "a message was sent" has to be RECONSTRUCTED. The rule this file
// is built on:
//
//     Prefer what an agent RECORDED. Scrape a screen only when nothing recorded it.
//
// That axis is not CLI versus MCP. An agent that wrote the call down as it made it gives an
// exact sender, an exact recipient, the whole text and a real time, whichever tool it used. A
// screen gives whatever survived the last repaint. Ranked by that, best first:
//
//   RECORDED, and therefore exact:
//   1. A Claude session's own transcript, which keeps every `mcp__superset__*` call with its
//      arguments. An orchestrator driving the fleet through the Superset MCP server types no
//      `superset` command at all, so (3) sees literally nothing from it — lib/transcripts.js.
//   2. The fleet log, when an orchestrator sends through `bin/superset-send`, which writes one
//      line per message as it sends it — lib/fleetlog.js.
//
//   SCRAPED, and therefore best-effort. An event from these is a claim that the screens
//   changed in a way consistent with a message, never a claim that the CLI reported one:
//   3. An orchestrator's own screen, which logs every `superset` command it TYPED. It names
//      the target workspace and, when not elided, the message text.
//   4. A worker's status flipping idle→working, which is what receiving work looks like from
//      the outside. Used so the world still moves when a command has scrolled off.
//
// The sources are disjoint by construction rather than by arbitration, so a message is counted
// once however many of them knew about it: an MCP call reaches the screen as `Called superset
// 2 times`, the wrapper's command line is `superset-send …`, and (3) matches neither.
//
// There can be more than one orchestrator running at a time, so none of this is written in
// terms of "the" hub: hubs are a set, and every attribution names WHICH hub it belongs to.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { listWorkspaces, listTerminals, readTerminal, mapLimit } from './superset.js';
import { classifyTerminal } from './parse.js';
import { FleetLog } from './fleetlog.js';
import { Transcripts } from './transcripts.js';

/**
 * Whatever `terminals read` returns is parsed in full — for Codex that is a scrollback of
 * hundreds of commands the last screenful does not hold — but only this much of it goes to
 * the browser, where it is a preview and every agent's is sent on every tick.
 *
 * Claude draws on the alternate screen, so there IS no scrollback: its read returns the ~50
 * visible lines and nothing else. A Claude orchestrator's commands are therefore only ever
 * seen while they are still on screen, which is why the poll is fast and the evidence it
 * gathers is cumulative — see #electHubs.
 */
const CLIENT_SCREEN_LINES = 80;

/** Terminal reads are the bulk of a poll; six at a time keeps a tick near one CLI round-trip. */
const READ_CONCURRENCY = 6;

/**
 * How many DISTINCT peers an agent must command before it counts as orchestrating them.
 *
 * One is too few in both directions: a worker reporting back to its orchestrator has commanded
 * exactly one peer, and so has a human poking at a neighbouring session from a shell.
 */
const HUB_MIN_FANOUT = 2;

const STATUS_RANK = { waiting: 4, working: 3, idle: 2, exited: 0 };

/**
 * What a recorded call looks like in the world. `create` is a spawn rather than a message: the
 * orchestrator did not talk to a running agent, it started one — which is still a command, and
 * still evidence that it is running the place.
 */
const EVENT_OF_VERB = { send: 'send', read: 'read', create: 'spawn' };

let sequence = 0;
const nextEventId = () => `e${++sequence}`;

export class World {
  /**
   * @param {string | null} statePath where the link tally survives restarts; null to forget
   * @param {string | null} logPath the fleet log `bin/superset-send` appends to; null to ignore
   * @param {string | null} transcriptRoot Claude Code's per-project sessions; null to ignore
   */
  constructor(statePath = null, logPath = null, transcriptRoot = null) {
    this.statePath = statePath;
    this.log = new FleetLog(logPath);
    this.transcripts = new Transcripts(transcriptRoot);
    this.dirty = false;
    /** @type {Map<string, object>} workspaceId → last tick's agent record */
    this.previous = new Map();
    /** @type {Map<string, Map<string, number>>} terminalId → CLI-call signature → times seen */
    this.callCounts = new Map();
    /**
     * @type {Map<string, Set<string>>} workspaceId → peers it has been seen COMMANDING
     * (`terminals send`, `workspaces create`), accumulated. This is the evidence an agent is
     * orchestrating; reads are kept apart in `watches` precisely so they cannot elect anyone.
     */
    this.drives = new Map();
    /** @type {Map<string, Set<string>>} workspaceId → peers it has merely READ, accumulated */
    this.watches = new Map();
    /**
     * @type {Map<string, object>} "from|to" → running totals for that pair. The server caps
     * its event history; this tally is what lets a beam still read "43 messages" hours in.
     */
    this.links = new Map();
    this.tick = 0;
    /** @type {string[]} every workspace currently judged to be orchestrating others */
    this.hubIds = [];
  }

  /**
   * Who has driven whom is the structure of the whole picture, and it is learnt only by
   * watching. Without this a restart mid-orchestration would put every worker back on the
   * outer ring until the orchestrator happened to message each one again.
   *
   * Only the structure is kept. Counts and threads are rebuilt from the scrollback on every
   * start: the screens are the source of truth, and a saved tally re-counted against the same
   * screens it came from would double every number.
   */
  async load() {
    if (!this.statePath) return;
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8'));
      // A pre-multi-orchestrator file has `fanout` instead, which counted a read as driving.
      // It is deliberately NOT imported: nothing here is ever pruned, so one polluted entry
      // would elect a session that had merely looked at two screens, for good. A Codex
      // orchestrator's whole scrollback is re-read on the first tick anyway, and a Claude one
      // is re-learnt from its next command — one restart's worth of memory is the cheaper loss.
      for (const [id, peers] of Object.entries(saved.drives ?? {})) {
        this.drives.set(id, new Set(peers));
      }
      for (const [id, peers] of Object.entries(saved.watches ?? {})) {
        this.watches.set(id, new Set(peers));
      }
      const hubs = saved.hubIds ?? (saved.hubId ? [saved.hubId] : []);
      this.hubIds = hubs.filter(Boolean);
    } catch {
      // No state yet, or an unreadable file: start cold, which is what we would do anyway.
    }
  }

  async #save() {
    if (!this.statePath || !this.dirty) return;
    this.dirty = false;
    const spread = (map) => Object.fromEntries([...map].map(([id, peers]) => [id, [...peers]]));
    const state = {
      hubIds: this.hubIds,
      drives: spread(this.drives),
      watches: spread(this.watches),
    };
    // Write-then-rename so a crash mid-write leaves the previous file, not half a JSON.
    const tmp = `${this.statePath}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, this.statePath);
    } catch {
      this.dirty = true; // try again next tick
    }
  }

  async poll() {
    this.tick += 1;
    const { ok, error, workspaces } = await listWorkspaces();
    if (!ok) return this.#snapshot({ error, agents: [], events: [] });

    // An archived workspace or a worktree deleted from under Superset has no one home; drawing
    // a house for it would leave the world littered with rooms nothing can ever happen in.
    const live = workspaces.filter((w) => !w.archivedAt && w.worktreeExists !== false);

    const agents = (await mapLimit(live, READ_CONCURRENCY, (ws) => this.#readWorkspace(ws))).filter(
      Boolean,
    );

    // Read the written-down sources for the same window the screens were read in, so all
    // three describe one tick. Both are cheap — a stat, and a read only when a file grew.
    const [logged, scripted] = await Promise.all([this.log.read(), this.transcripts.read(live)]);
    const recorded = [...logged, ...scripted].sort((a, b) => a.at - b.at);

    // The diff is what files this tick's commands as evidence, so the election runs after it:
    // an orchestrator whose second worker was messaged just now is a chef in this same snapshot.
    const events = this.#diff(agents, recorded);
    this.#electHubs(agents);
    this.previous = new Map(agents.map((a) => [a.id, a]));
    await this.#save();

    return this.#snapshot({ error: null, agents, events });
  }

  #snapshot({ error, agents, events }) {
    return {
      tick: this.tick,
      at: Date.now(),
      error,
      logError: this.log.error,
      transcriptError: this.transcripts.error,
      hubIds: this.hubIds,
      agents,
      events,
      links: [...this.links.values()],
    };
  }

  async #readWorkspace(ws) {
    const { sessions } = await listTerminals(ws.id);
    const terminals = await mapLimit(sessions, READ_CONCURRENCY, async (session) => {
      const screen = await readTerminal(ws.id, session.terminalId);
      const parsed = classifyTerminal({ title: session.title, text: screen.text });
      return {
        id: session.terminalId,
        title: session.title ?? '',
        createdAt: session.createdAt,
        attached: Boolean(session.attached),
        exited: Boolean(session.exited),
        screen: screen.text.split('\n').slice(-CLIENT_SCREEN_LINES).join('\n'),
        ...parsed,
        status: session.exited ? 'exited' : parsed.status,
      };
    });

    // Every worktree opens with a plain shell next to its agent, and a shell has nothing to
    // say. Rooms are for agents: the shells are dropped, and a workspace with nobody but a
    // shell in it gets no room at all.
    const agents = terminals.filter((t) => t.flavor !== 'shell');
    if (!agents.length) return null;

    // Roll up to the most interesting terminal rather than the first one listed.
    const lead = agents.slice().sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];

    return {
      id: ws.id,
      name: ws.name,
      project: ws.projectName ?? 'session',
      branch: lead.branch || ws.branch,
      type: ws.type,
      worktreePath: ws.worktreePath,
      createdAt: ws.createdAt,
      status: lead.status,
      flavor: lead.flavor,
      model: lead.model,
      activity: lead.activity,
      says: lead.says,
      queued: lead.queued,
      leadTerminalId: lead.id,
      terminals: agents,
    };
  }

  /**
   * New CLI calls on an agent's screen, counted rather than remembered by identity: the same
   * command runs many times against the same worker, and the screen keeps showing the old one.
   * Comparing counts per signature emits exactly the calls that appeared since the last tick,
   * and silently emits nothing when the buffer scrolls a call off (a miss, never a phantom).
   */
  #newCalls(terminal) {
    const signatureOf = (call) =>
      `${call.verb}:${call.workspaceId}:${call.terminalId ?? ''}:${call.text ?? ''}`;

    const now = new Map();
    for (const call of terminal.calls) {
      const key = signatureOf(call);
      now.set(key, (now.get(key) ?? 0) + 1);
    }
    const before = this.callCounts.get(terminal.id) ?? new Map();
    this.callCounts.set(terminal.id, now);

    const remaining = new Map();
    for (const [key, count] of now) remaining.set(key, count - (before.get(key) ?? 0));

    // Emit the LAST n occurrences of each signature: when a screen holds three copies of a
    // command and one is new, the newest is the one at the bottom.
    const fresh = [];
    for (let i = terminal.calls.length - 1; i >= 0; i--) {
      const key = signatureOf(terminal.calls[i]);
      if ((remaining.get(key) ?? 0) <= 0) continue;
      remaining.set(key, remaining.get(key) - 1);
      fresh.unshift(terminal.calls[i]);
    }
    return fresh;
  }

  #touchLink(fromId, toId, kind, text, at) {
    const key = `${fromId}|${toId}`;
    const link = this.links.get(key) ?? {
      fromId,
      toId,
      sends: 0,
      reads: 0,
      replies: 0,
      lastAt: 0,
      lastKind: null,
      lastText: null,
    };
    // A spawn that carries a brief is a message: `agents_create` hands a worker the longest
    // and most consequential text of the whole run. A spawn without one is a session merely
    // appearing, and counting that would put a phantom in every worker's tally.
    if (kind === 'send' || kind === 'inbox' || (kind === 'spawn' && text)) link.sends += 1;
    else if (kind === 'read') link.reads += 1;
    else if (kind === 'report') link.replies += 1;
    // A bootstrapped call carries no timestamp; it must not overwrite a real one.
    if (at >= link.lastAt) {
      link.lastAt = at;
      link.lastKind = kind;
      if (text) link.lastText = text;
    }
    this.links.set(key, link);
  }

  #diff(agents, recorded = []) {
    const events = [];
    const at = Date.now();
    const byId = new Map(agents.map((a) => [a.id, a]));
    const push = (kind, fromId, toId, text, replay = false, when = at) => {
      events.push({
        id: nextEventId(),
        at: replay ? 0 : when,
        kind,
        fromId,
        toId,
        text: text || null,
        replay,
      });
      // A dispatch is an inference about a worker, not an exchange between two rooms; it
      // moves the world but does not count toward the beam between them.
      if (fromId && toId && kind !== 'dispatch') {
        this.#touchLink(fromId, toId, kind, text, replay ? 0 : when);
      }
    };

    // The written-down messages first. They are the exact record of this window's traffic, and
    // a message in either of them is one the screens were never needed for: the wrapper's own
    // command line is `superset-send …` and an MCP call reaches the screen as `Called superset
    // 2 times`, neither of which the screen parser matches. So a message is only ever counted
    // once, no matter which source knew about it.
    //
    // A transcript seen for the first time arrives as REPLAY — the session was running before
    // this process was — which fills the tally and seats its workers without firing a morning
    // of old mail across the island. See lib/transcripts.js.
    for (const message of recorded) {
      if (!byId.has(message.fromId) || !byId.has(message.toId)) continue;
      if (message.fromId === message.toId) continue;
      this.#recordCall(message.fromId, { verb: message.verb, workspaceId: message.toId });
      const kind = EVENT_OF_VERB[message.verb];
      if (kind) {
        push(kind, message.fromId, message.toId, message.text, Boolean(message.replay), message.at);
      }
    }

    for (const agent of agents) {
      const before = this.previous.get(agent.id);

      if (!before) {
        if (this.tick > 1) push('spawn', null, agent.id, agent.name);
        // A screen seen for the first time is a log of traffic that already happened. It is
        // emitted as REPLAY: it fills the tally and the threads — so the rings, the beams and
        // the conversations are all there on tick one — but carries no timestamp and is never
        // animated, which would fire a minute of old mail across the island on start-up.
        for (const terminal of agent.terminals) {
          for (const call of this.#newCalls(terminal)) {
            if (call.workspaceId === agent.id || !byId.has(call.workspaceId)) continue;
            this.#recordCall(agent.id, call);
            const kind = call.verb === 'send' ? 'send' : call.verb === 'read' ? 'read' : null;
            if (kind) push(kind, agent.id, call.workspaceId, call.text, true);
          }
        }
        continue;
      }

      for (const terminal of agent.terminals) {
        for (const call of this.#newCalls(terminal)) {
          if (call.workspaceId === agent.id) continue; // reading its own screen is not traffic
          if (!byId.has(call.workspaceId)) continue;
          this.#recordCall(agent.id, call);
          if (call.verb === 'send') push('send', agent.id, call.workspaceId, call.text);
          else if (call.verb === 'read') push('read', agent.id, call.workspaceId, null);
          else if (call.verb === 'create') push('spawn', agent.id, call.workspaceId, call.text);
        }
      }

      if (before.status !== agent.status) {
        // A status flip is only evidence of a MESSAGE if a hub has actually been driving this
        // agent, and then only from THAT hub. Attributing every idle→working edge to whichever
        // orchestrator happens to be first in the list would draw arrows between workspaces
        // that have never contacted each other — a human typing in their own terminal, or
        // another orchestrator's worker — which is precisely the lie this view must not tell.
        const counterpart = this.#hubDriving(agent.id);
        if (agent.status === 'working' && before.status === 'idle') {
          push('dispatch', counterpart, agent.id, agent.activity);
        } else if (agent.status === 'idle' && before.status === 'working') {
          push('report', agent.id, counterpart, agent.says);
        } else if (agent.status === 'waiting') {
          push('waiting', agent.id, null, agent.activity);
        }
      }

      // A queued follow-up is the receiving half of a send, and carries the text the
      // orchestrator's own screen usually elides. Emit it once, when it first appears.
      const known = new Set(before.queued ?? []);
      for (const message of agent.queued) {
        if (!known.has(message)) push('inbox', this.#hubDriving(agent.id), agent.id, message);
      }
    }

    for (const [id, before] of this.previous) {
      if (!byId.has(id)) push('gone', null, id, before.name);
    }

    return events;
  }

  /**
   * Which hub, if any, is driving this workspace — the one that has commanded it most recently.
   *
   * A worker can be spoken to by more than one orchestrator over its life (handed over, or
   * simply borrowed), and an unattributed flip belongs to whoever last had it.
   */
  #hubDriving(agentId) {
    let best = null;
    let bestAt = -1;
    for (const hubId of this.hubIds) {
      if (hubId === agentId) continue;
      if (!this.drives.get(hubId)?.has(agentId)) continue;
      const at = this.links.get(`${hubId}|${agentId}`)?.lastAt ?? 0;
      if (at >= bestAt) {
        best = hubId;
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * File one observed CLI call as evidence about who is running whom.
   *
   * `send` and `create` are COMMANDS — the caller is making another agent do something — and
   * only they count toward orchestrating. `read` and `list` are filed separately: looking at a
   * screen is what a curious human, a status sweep or this very tool does, and letting two
   * reads elect an orchestrator would hand the kitchen to whichever session last went browsing.
   */
  #recordCall(fromId, call) {
    const commands = call.verb === 'send' || call.verb === 'create';
    const into = commands ? this.drives : this.watches;
    if (!into.has(fromId)) into.set(fromId, new Set());
    if (!into.get(fromId).has(call.workspaceId)) this.dirty = true;
    into.get(fromId).add(call.workspaceId);
  }

  /** Live peers `id` has commanded, and live peers that have commanded `id`. */
  #degree(id, alive) {
    const out = [...(this.drives.get(id) ?? [])].filter((p) => p !== id && alive.has(p));
    const into = [];
    for (const [from, peers] of this.drives) {
      if (from !== id && alive.has(from) && peers.has(id)) into.push(from);
    }
    return { out, into };
  }

  /**
   * Orchestrators are whoever is actually driving other workspaces. They are elected from
   * observed traffic rather than from their names, there can be several at once, and the
   * evidence is cumulative: a Claude orchestrator's commands are only visible while they are
   * on screen, so the set it has been seen commanding is built up a poll at a time and kept.
   *
   * Two shapes count:
   *
   *   - It commands two or more distinct peers. This is an orchestrator by definition, and it
   *     is the only rule that fires for a session whose own screen we can read.
   *   - Two or more distinct peers command IT, and nobody is orchestrating it. This is the
   *     same fleet seen from the other end — the workers' `terminals send … --workspace <hub>`
   *     reports — and it recovers an orchestrator whose own commands were never caught on
   *     screen. The second half of that test is what keeps it from promoting a worker that
   *     its orchestrator and a neighbour both happened to message.
   *
   * The name is only a cold-start fallback: before any traffic has been seen there is nothing
   * to go on, and a world with no kitchen at all reads as broken.
   */
  #electHubs(agents) {
    const alive = new Set(agents.map((a) => a.id));
    const commanders = new Set();
    for (const id of alive) {
      if (this.#degree(id, alive).out.length >= HUB_MIN_FANOUT) commanders.add(id);
    }

    const hubs = new Set(commanders);
    for (const id of alive) {
      if (hubs.has(id)) continue;
      const { into } = this.#degree(id, alive);
      const reporters = into.filter((from) => !commanders.has(from));
      if (reporters.length >= HUB_MIN_FANOUT) hubs.add(id);
    }

    // Deliberately ONE, however many match. This is a guess from a name, not evidence: it
    // exists so a fleet that has not been watched long enough to see any traffic still has a
    // kitchen rather than reading as broken. Promoting everything called `orchestrat*` turns a
    // modest guess into several confident wrong ones — a workspace named after the work, like
    // "Support multiple orchestrators in Agent Fleet", is not thereby orchestrating anything.
    // It is dropped the moment a single real command is observed.
    if (!hubs.size) {
      const named = agents.find((a) => /orchestrat/i.test(a.name));
      if (named) hubs.add(named.id);
    }

    // Stable order, so a chef keeps its station in the kitchen as others come and go.
    const next = [...this.hubIds.filter((id) => hubs.has(id)), ...[...hubs].sort()].filter(
      (id, i, all) => all.indexOf(id) === i,
    );
    if (next.length !== this.hubIds.length || next.some((id, i) => id !== this.hubIds[i])) {
      this.hubIds = next;
      this.dirty = true;
    }
  }
}
