// The fleet as a world: who exists, what they are doing, and what just happened between them.
//
// Everything here is a diff against the previous poll. The CLI exposes no message history —
// only current screens — so "a message was sent" has to be RECONSTRUCTED from two things:
//
//   1. The orchestrator's own screen, which logs every `superset` command it ran. This is the
//      only exact source: it names the target workspace and, when not elided, the message text.
//   2. A worker's status flipping idle→working, which is what receiving work looks like from
//      the outside. Used as a fallback so the world still moves when a command has scrolled
//      off the orchestrator's screen.
//
// Both are best-effort by construction. An event is a claim that the screens changed in a way
// consistent with a message, never a claim that the CLI reported one.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { listWorkspaces, listTerminals, readTerminal, mapLimit } from './superset.js';
import { classifyTerminal } from './parse.js';

/**
 * The whole scrollback is read and parsed — an orchestrator's buffer holds hundreds of
 * commands the last screenful does not — but only this much of it goes to the browser,
 * where it is a preview and every agent's is sent on every tick.
 */
const CLIENT_SCREEN_LINES = 80;

/** Terminal reads are the bulk of a poll; six at a time keeps a tick near one CLI round-trip. */
const READ_CONCURRENCY = 6;

/** An agent must reference this many DISTINCT peers before it counts as orchestrating them. */
const HUB_MIN_FANOUT = 2;

const STATUS_RANK = { waiting: 4, working: 3, idle: 2, exited: 0 };

let sequence = 0;
const nextEventId = () => `e${++sequence}`;

export class World {
  /** @param {string | null} statePath where the link tally survives restarts; null to forget */
  constructor(statePath = null) {
    this.statePath = statePath;
    this.dirty = false;
    /** @type {Map<string, object>} workspaceId → last tick's agent record */
    this.previous = new Map();
    /** @type {Map<string, Map<string, number>>} terminalId → CLI-call signature → times seen */
    this.callCounts = new Map();
    /** @type {Map<string, Set<string>>} workspaceId → peers it has driven, accumulated */
    this.fanout = new Map();
    /**
     * @type {Map<string, object>} "from|to" → running totals for that pair. The server caps
     * its event history; this tally is what lets a beam still read "43 messages" hours in.
     */
    this.links = new Map();
    this.tick = 0;
    this.hubId = null;
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
      for (const [id, peers] of Object.entries(saved.fanout ?? {})) {
        this.fanout.set(id, new Set(peers));
      }
      if (saved.hubId) this.hubId = saved.hubId;
    } catch {
      // No state yet, or an unreadable file: start cold, which is what we would do anyway.
    }
  }

  async #save() {
    if (!this.statePath || !this.dirty) return;
    this.dirty = false;
    const state = {
      hubId: this.hubId,
      fanout: Object.fromEntries([...this.fanout].map(([id, peers]) => [id, [...peers]])),
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

    const events = this.#diff(agents);
    this.#electHub(agents);
    this.previous = new Map(agents.map((a) => [a.id, a]));
    await this.#save();

    return this.#snapshot({ error: null, agents, events });
  }

  #snapshot({ error, agents, events }) {
    return {
      tick: this.tick,
      at: Date.now(),
      error,
      hubId: this.hubId,
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
    if (kind === 'send' || kind === 'inbox') link.sends += 1;
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

  #diff(agents) {
    const events = [];
    const at = Date.now();
    const byId = new Map(agents.map((a) => [a.id, a]));
    const push = (kind, fromId, toId, text, replay = false) => {
      events.push({
        id: nextEventId(),
        at: replay ? 0 : at,
        kind,
        fromId,
        toId,
        text: text || null,
        replay,
      });
      // A dispatch is an inference about a worker, not an exchange between two rooms; it
      // moves the world but does not count toward the beam between them.
      if (fromId && toId && kind !== 'dispatch') {
        this.#touchLink(fromId, toId, kind, text, replay ? 0 : at);
      }
    };

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
            this.#recordFanout(agent.id, call.workspaceId);
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
          this.#recordFanout(agent.id, call.workspaceId);
          if (call.verb === 'send') push('send', agent.id, call.workspaceId, call.text);
          else if (call.verb === 'read') push('read', agent.id, call.workspaceId, null);
          else if (call.verb === 'create') push('spawn', agent.id, call.workspaceId, call.text);
        }
      }

      if (before.status !== agent.status) {
        // A status flip is only evidence of a MESSAGE if the hub has actually been driving
        // this agent. Attributing every idle→working edge to the hub would draw arrows to
        // workspaces it has never contacted — a human typing in their own terminal, or a
        // second orchestrator's worker — which is precisely the lie this view must not tell.
        const counterpart = this.#drivenByHub(agent.id) ? this.hubId : null;
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
        if (!known.has(message)) {
          push('inbox', this.#drivenByHub(agent.id) ? this.hubId : null, agent.id, message);
        }
      }
    }

    for (const [id, before] of this.previous) {
      if (!byId.has(id)) push('gone', null, id, before.name);
    }

    return events;
  }

  /** Has the elected hub been observed driving this workspace at least once? */
  #drivenByHub(agentId) {
    if (!this.hubId || this.hubId === agentId) return false;
    return this.fanout.get(this.hubId)?.has(agentId) ?? false;
  }

  #recordFanout(fromId, toId) {
    if (!this.fanout.has(fromId)) this.fanout.set(fromId, new Set());
    if (!this.fanout.get(fromId).has(toId)) this.dirty = true;
    this.fanout.get(fromId).add(toId);
  }

  /**
   * The orchestrator is whoever is actually driving other workspaces, so it is elected from
   * observed traffic rather than from its name. The name is only a cold-start fallback: on the
   * first ticks nothing has been observed yet, and a world with no centre reads as broken.
   */
  #electHub(agents) {
    const alive = new Set(agents.map((a) => a.id));
    let best = null;
    let bestScore = 0;
    for (const [id, peers] of this.fanout) {
      if (!alive.has(id)) continue;
      const score = [...peers].filter((p) => alive.has(p)).length;
      if (score > bestScore) {
        best = id;
        bestScore = score;
      }
    }
    if (best && bestScore >= HUB_MIN_FANOUT) {
      if (this.hubId !== best) this.dirty = true;
      this.hubId = best;
      return;
    }
    if (this.hubId && alive.has(this.hubId)) return;
    this.hubId = agents.find((a) => /orchestrat/i.test(a.name))?.id ?? null;
  }
}
