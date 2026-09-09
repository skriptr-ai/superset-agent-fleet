// The restaurant: who is seated, who is queueing at the door, what the waiters are carrying,
// and the chef behind the pass.
//
// The room is drawn straight onto the retina canvas at the current zoom, so it is crisp at
// any scale and zooming is continuous. Everything with a position lives on the tile grid;
// anyone who moves walks it tile by tile along a BFS path.

import {
  TILE_W,
  TILE_H,
  iso,
  floor,
  walls,
  wallPicture,
  wallLamp,
  shelf,
  table,
  chair,
  counter,
  stove,
  plant,
  serviceBell,
  ropePost,
  hostStand,
  doormat,
  figure,
  dinerPalette,
  chefPalette,
  waiterPalette,
  hostPalette,
  lookFor,
  logoVector,
  cardTable,
  tray,
  exclaim,
  fork,
  roundRect,
  wrapText,
  issueOf,
  STATUS,
  KIND_COLOR,
} from './draw.js';

const WALL_H = 72;
const KITCHEN_ROWS = 4; // y = 0..3 is the kitchen; the counter runs along y = 4
const COUNTER_Y = 4;
const FIRST_TABLE_Y = 8;
const TABLE_GAP = 4;
const ENTRANCE_X = 2;
const ZOOM_MIN = 0.45; // screen pixels per world unit
const ZOOM_MAX = 6;

const STEP_MS = 230;
const HANDOFF_MS = 600;
const SERVE_PAUSE_MS = 900;
const GLANCE_MS = 950;
const BUBBLE_MS = 7000;
const BUBBLE_STACK = 3; // bubbles kept over one head; older ones make room
const TOAST_MS = 6500;
const GREET_MS = 1400;
const WAITERS = 3;
const PICKUP_MS = 500;

export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.cameraTarget = null;
    /** Where the wheel is heading, and the screen point to keep still while it gets there. */
    this.zoomTarget = null;
    this.zoomAnchor = null;
    this.agents = [];
    this.hubId = null;
    this.links = [];
    this.conns = new Map();
    this.room = null;
    this.slots = [];
    this.tableOf = new Map();
    this.placement = new Map();
    this.queue = [];
    this.blocked = new Set();
    this.blockedStaff = new Set();
    this.movers = [];
    this.waiters = [];
    this.orders = [];
    this.hitboxes = [];
    this.glances = [];
    this.chefPose = null;
    this.hostPose = null;
    this.bubbles = new Map();
    this.toasts = [];
    this.selectedId = null;
    this.hoverId = null;
    this.pointer = { x: 0, y: 0 };
    this.showReads = true;
    this.onSelect = () => {};
    this.needsFit = true;
    /** Override to freeze or scrub the animation clock; null means real time. */
    this.clock = null;

    this.#bindInput();
    this.#resize();
    window.addEventListener('resize', () => this.#resize());
    requestAnimationFrame(() => this.#frame());
  }

  #now() {
    return this.clock ? this.clock() : performance.now();
  }

  // ── world state ───────────────────────────────────────────────────────────────────────────

  setWorld(agents, hubId, links) {
    this.agents = agents;
    this.hubId = hubId;
    this.links = links ?? [];
    this.#indexLinks();
    this.#layout();
    if (this.needsFit && this.agents.length) {
      this.fit(true);
      this.needsFit = false;
    }
  }

  /**
   * One record per worker, both directions folded together. A worker is a diner the chef
   * has DRIVEN — a link outbound from the hub. The reverse direction alone does not qualify:
   * a session that merely read the orchestrator's screen is not one of its workers.
   */
  #indexLinks() {
    this.conns = new Map();
    if (!this.hubId) return;
    const driven = new Set(this.links.filter((l) => l.fromId === this.hubId).map((l) => l.toId));
    for (const link of this.links) {
      const worker = link.fromId === this.hubId ? link.toId : link.fromId;
      if (!driven.has(worker) || (link.fromId !== this.hubId && link.toId !== this.hubId)) continue;
      const conn = this.conns.get(worker) ?? {
        workerId: worker,
        sends: 0,
        reads: 0,
        replies: 0,
        lastAt: 0,
        lastKind: null,
      };
      conn.sends += link.sends;
      conn.reads += link.reads;
      conn.replies += link.replies;
      if (link.lastAt > conn.lastAt) {
        conn.lastAt = link.lastAt;
        conn.lastKind = link.lastKind;
      }
      this.conns.set(worker, conn);
    }
  }

  /**
   * Build the room for a party of `capacity`: a kitchen at the back, tables four tiles apart,
   * and a lobby along the front with the maître d's podium beside the gap in the rope.
   */
  #buildRoom(capacity) {
    const cols = Math.max(2, Math.ceil(Math.sqrt(capacity * 1.4)));
    const rows = Math.max(1, Math.ceil(capacity / cols));
    const w = cols * TABLE_GAP + 3;
    const lobbyY = FIRST_TABLE_Y + (rows - 1) * TABLE_GAP + 2;
    const d = lobbyY + 4;
    const gate = w - 2;
    const chef = { x: Math.max(2, Math.floor(w / 2) - 2), y: 2 };
    const station = { x: chef.x + 4, y: 1 };
    this.room = {
      w,
      d,
      gate,
      chef,
      pickup: { x: chef.x, y: 3 },
      station,
      // Around the card table, on its far sides, so the table hides their laps like a diner's.
      waiterSeats: [
        { x: station.x - 1, y: station.y },
        { x: station.x, y: station.y - 1 },
        { x: station.x - 1, y: station.y - 1 },
      ],
      lobbyY,
      entrance: { x: ENTRANCE_X, y: lobbyY },
      podium: { x: ENTRANCE_X - 1, y: lobbyY + 2 },
      host: { x: ENTRANCE_X - 1, y: lobbyY + 1 },
    };

    // Tables row by row, kitchen side first, each row filled from the centre outward — so
    // the first tables handed out are the good ones.
    this.slots = [];
    for (let j = 0; j < rows; j++) {
      const order = [];
      let left = Math.floor((cols - 1) / 2);
      let right = left + 1;
      for (let i = 0; i < cols; i++) order.push(i % 2 === 0 ? left-- : right++);
      for (const i of order)
        this.slots.push({ tx: 2 + i * TABLE_GAP, ty: FIRST_TABLE_Y + j * TABLE_GAP });
    }

    // Two maps of what cannot be walked through: guests may not enter the kitchen at all;
    // staff may, but not through the stove, the chef, the card table or the counter.
    this.blocked = new Set();
    this.blockedStaff = new Set();
    const block = (x, y, staffToo = true) => {
      this.blocked.add(`${x},${y}`);
      if (staffToo) this.blockedStaff.add(`${x},${y}`);
    };
    for (const s of this.slots) {
      block(s.tx, s.ty);
      block(s.tx, s.ty - 1);
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < COUNTER_Y; y++) block(x, y, false);
      if (x !== gate) block(x, COUNTER_Y);
      if (x !== ENTRANCE_X) block(x, lobbyY);
    }
    block(chef.x - 1, chef.y);
    block(chef.x, chef.y);
    block(station.x, station.y);
    block(this.room.podium.x, this.room.podium.y);
    block(this.room.host.x, this.room.host.y);

    this.capacity = capacity;
    this.tableOf = new Map();
    this.placement = new Map();
    this.queue = [];
    this.movers = [];
    this.orders = [];
    this.waiters = this.room.waiterSeats.slice(0, WAITERS).map((seat, index) => ({
      index,
      seat,
      pal: waiterPalette(index),
      task: null,
      pos: null,
    }));
  }

  /** Where the n-th person in line stands: two tiles apart so nobody overlaps, wrapping to
   * a second row if the lobby fills up. */
  #queueTile(index) {
    const { w, lobbyY } = this.room;
    const perRow = Math.max(1, Math.floor((w - ENTRANCE_X - 1) / 2));
    return { x: ENTRANCE_X + 2 * (index % perRow), y: lobbyY + 2 + Math.floor(index / perRow) };
  }

  #seatOf(id) {
    const slot = this.slots[this.tableOf.get(id)];
    return slot
      ? {
          tx: slot.tx,
          ty: slot.ty,
          cx: slot.tx,
          cy: slot.ty - 1,
          serveX: slot.tx - 1,
          serveY: slot.ty,
        }
      : null;
  }

  /**
   * Seating and the queue. A table is assigned once and kept — nobody is moved between
   * tables mid-meal — with the chef's workers served first when the room is built. Idle
   * diners wait in line at the door; when one starts working it walks to its table, and when
   * it stops it walks back to the end of the line.
   */
  #layout() {
    const guests = this.agents.filter((a) => a.id !== this.hubId);
    const alive = new Set(guests.map((a) => a.id));
    // Rebuild when the party outgrows the room, or when it has shrunk enough (a project filter,
    // say) that most tables would sit empty. Everyone is re-seated; that only happens here.
    if (!this.room || guests.length > this.capacity || guests.length < this.capacity - 5) {
      this.#buildRoom(guests.length + 2);
    }
    const fresh = this.placement.size === 0;

    for (const id of [...this.tableOf.keys()]) {
      if (!alive.has(id)) {
        this.tableOf.delete(id);
        this.placement.delete(id);
        this.queue = this.queue.filter((q) => q !== id);
        this.movers = this.movers.filter((m) => m.id !== id);
      }
    }
    const taken = new Set(this.tableOf.values());
    const unseated = guests
      .filter((a) => !this.tableOf.has(a.id))
      .sort((a, b) => {
        const ca = this.conns.get(a.id);
        const cb = this.conns.get(b.id);
        if (Boolean(ca) !== Boolean(cb)) return ca ? -1 : 1;
        if (ca && cb) return (cb.lastAt || 0) - (ca.lastAt || 0);
        return a.name.localeCompare(b.name);
      });
    for (const agent of unseated) {
      const slot = this.slots.findIndex((_, i) => !taken.has(i));
      if (slot === -1) break;
      this.tableOf.set(agent.id, slot);
      taken.add(slot);
    }

    for (const agent of guests) {
      const seat = this.#seatOf(agent.id);
      if (!seat) continue;
      const wants = agent.status === 'idle' || agent.status === 'exited' ? 'queued' : 'seated';
      const cur = this.placement.get(agent.id);
      if (!cur) {
        // First sight: no walking, just put everyone where they are.
        if (wants === 'queued') {
          this.queue.push(agent.id);
          this.placement.set(agent.id, {
            mode: 'queued',
            tile: this.#queueTile(this.queue.length - 1),
          });
        } else {
          this.placement.set(agent.id, { mode: 'seated', tile: { x: seat.cx, y: seat.cy } });
        }
        continue;
      }
      if (cur.mode === 'walking') continue;
      if (cur.mode === wants) continue;
      if (wants === 'seated') {
        this.queue = this.queue.filter((q) => q !== agent.id);
        this.#walk(agent, cur.tile, { x: seat.cx, y: seat.cy }, 'seated');
      } else {
        // The latest arrival takes the front of the line, at the podium, and is greeted.
        this.queue.unshift(agent.id);
        this.#walk(agent, cur.tile, this.#queueTile(0), 'queued');
        if (!fresh) this.hostPose = { type: 'wave', until: this.#now() + GREET_MS };
      }
    }

    // Everyone still in line shuffles up to fill the gap left by whoever was seated.
    this.queue.forEach((id, index) => {
      const cur = this.placement.get(id);
      const target = this.#queueTile(index);
      if (!cur || cur.mode !== 'queued') return;
      if (cur.tile.x === target.x && cur.tile.y === target.y) return;
      const agent = this.agents.find((a) => a.id === id);
      if (agent) this.#walk(agent, cur.tile, target, 'queued');
    });
  }

  #walk(agent, from, to, thenMode) {
    const path = this.#path(from, to, new Set([`${to.x},${to.y}`, `${from.x},${from.y}`]));
    if (!path) {
      this.placement.set(agent.id, { mode: thenMode, tile: to });
      return;
    }
    this.placement.set(agent.id, { mode: 'walking', tile: from, then: thenMode });
    this.movers.push({
      id: agent.id,
      role: 'diner',
      flavor: agent.flavor,
      start: this.#now(),
      legs: [{ path }],
      leg: 0,
      onDone: () => this.placement.set(agent.id, { mode: thenMode, tile: to }),
    });
  }

  /** Shortest walk between two tiles, avoiding furniture and the kitchen. */
  #path(from, to, allow = new Set(), staff = false) {
    const { w, d } = this.room;
    const blocked = staff ? this.blockedStaff : this.blocked;
    const key = (x, y) => `${x},${y}`;
    const free = (x, y) =>
      x >= 0 && x < w && y >= 0 && y < d && (allow.has(key(x, y)) || !blocked.has(key(x, y)));
    if (!free(to.x, to.y)) return null;
    const prev = new Map([[key(from.x, from.y), null]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift();
      if (cur.x === to.x && cur.y === to.y) break;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (!free(nx, ny) || prev.has(key(nx, ny))) continue;
        prev.set(key(nx, ny), cur);
        queue.push({ x: nx, y: ny });
      }
    }
    if (!prev.has(key(to.x, to.y))) return null;
    const path = [];
    for (let cur = to; cur; cur = prev.get(key(cur.x, cur.y))) path.unshift({ x: cur.x, y: cur.y });
    return path;
  }

  addEvents(events) {
    const now = this.#now();
    if (!this.room) return;
    const { gate } = this.room;
    const door = { x: gate, y: COUNTER_Y };
    const hall = { x: gate, y: COUNTER_Y + 1 };
    for (const event of events) {
      const fromHub = event.fromId === this.hubId;
      const toHub = event.toId === this.hubId;
      const worker = fromHub ? event.toId : toHub ? event.fromId : null;
      const seat = worker ? this.#seatOf(worker) : null;
      const readable = event.text && event.kind !== 'read' && event.kind !== 'dispatch';

      if (event.kind === 'read' && fromHub && seat) {
        if (this.showReads)
          this.glances.push({ workerId: worker, start: now, until: now + GLANCE_MS });
        continue;
      }

      if ((event.kind === 'send' || event.kind === 'inbox') && fromHub && seat) {
        // The queue copy of a dish already ordered is the same dish; do not plate it twice.
        const duplicate =
          this.orders.some((o) => o.kind === 'send' && o.workerId === worker) ||
          this.waiters.some(
            (wt) =>
              wt.task?.kind === 'send' && wt.task.workerId === worker && now - wt.task.since < 6000,
          );
        if (!duplicate) this.orders.push({ kind: 'send', workerId: worker, event, since: now });
        continue;
      }

      if (event.kind === 'report' && toHub && seat) {
        this.orders.push({ kind: 'report', workerId: worker, event, since: now });
        continue;
      }

      if (readable && event.toId && (this.tableOf.has(event.toId) || event.toId === this.hubId)) {
        this.#say(event.toId, event, now);
      }
    }
    if (this.toasts.length > 4) this.toasts.splice(0, this.toasts.length - 4);
    if (this.orders.length > 12) this.orders.splice(0, this.orders.length - 12);
  }

  /**
   * Hand the oldest order to a free waiter. An order is a round trip: to the chef for the
   * dish, out through the gate to the table, and back to the card table — or, for a report,
   * out to the table for the note and back to the chef with it.
   */
  #dispatch(now) {
    while (this.orders.length) {
      const waiter = this.waiters.find((wt) => !wt.task);
      if (!waiter) return;
      const order = this.orders.shift();
      const seat = this.#seatOf(order.workerId);
      if (!seat) continue;
      const { pickup, gate } = this.room;
      const door = { x: gate, y: COUNTER_Y };
      const serve = { x: seat.serveX, y: seat.serveY };
      const allow = new Set([
        `${pickup.x},${pickup.y}`,
        `${waiter.seat.x},${waiter.seat.y}`,
        `${door.x},${door.y}`,
      ]);
      const walk = (from, to) => this.#path(from, to, allow, true);
      const legs =
        order.kind === 'send'
          ? [
              { path: walk(waiter.seat, pickup) },
              {
                pause: HANDOFF_MS,
                onStart: () =>
                  (this.chefPose = { type: 'handoff', until: this.#now() + HANDOFF_MS }),
              },
              { path: walk(pickup, serve), carry: 'send' },
              { pause: SERVE_PAUSE_MS, deliverTo: order.workerId },
              { path: walk(serve, waiter.seat) },
            ]
          : [
              { path: walk(waiter.seat, serve) },
              { pause: PICKUP_MS },
              { path: walk(serve, pickup), carry: 'report' },
              { pause: SERVE_PAUSE_MS, deliverTo: this.hubId },
              { path: walk(pickup, waiter.seat) },
            ];
      if (legs.some((leg) => leg.path === null)) continue; // unreachable table: skip the order
      waiter.task = {
        kind: order.kind,
        workerId: order.workerId,
        event: order.event,
        legs,
        leg: 0,
        start: now,
        since: now,
      };
      waiter.pos = { ...waiter.seat };
    }
  }

  /**
   * Put a message over someone's head. Several arriving close together stack — a worker
   * being briefed in three parts should show three bubbles, not the last one — capped so a
   * chatty orchestrator cannot wallpaper the room.
   */
  #say(whoId, event, at) {
    const stack = this.bubbles.get(whoId) ?? [];
    stack.push({ text: event.text, kind: event.kind, event, start: at, until: at + BUBBLE_MS });
    while (stack.length > BUBBLE_STACK) stack.shift();
    this.bubbles.set(whoId, stack);
    this.toasts.push({ event, start: at, until: at + TOAST_MS });
  }

  /** `PT-559 ← chef` / `PT-559 → chef`: who is talking to whom, by issue key. */
  #bubbleHeader(event, byId) {
    const from = byId.get(event.fromId);
    const to = byId.get(event.toId);
    const tag = (agent) => {
      if (!agent) return 'someone';
      if (agent.id === this.hubId) return 'chef';
      return issueOf(agent.name, agent.branch).key ?? agent.name.slice(0, 18);
    };
    return event.kind === 'report' ? `${tag(from)}  →  ${tag(to)}` : `${tag(to)}  ←  ${tag(from)}`;
  }

  /**
   * Advance everyone on the move. A leg is either a path (walked one tile per STEP_MS) or a
   * pause at a table, at the end of which the message is delivered.
   */
  #stepMovers(t) {
    const done = [];
    for (const m of this.movers) if (this.#advance(m, t)) done.push(m);
    for (const m of done) m.onDone?.();
    this.movers = this.movers.filter((m) => !done.includes(m));

    this.#dispatch(t);
    for (const wt of this.waiters) {
      if (!wt.task) continue;
      if (this.#advance(wt.task, t)) {
        wt.task = null;
        wt.pos = { ...wt.seat };
        wt.dir = null;
        wt.step = 0;
        wt.carry = null;
      } else {
        wt.pos = wt.task.pos ?? wt.pos;
        wt.dir = wt.task.dir;
        wt.step = wt.task.step;
        wt.carry = wt.task.carry;
      }
    }
  }

  /**
   * Advance one walker along its legs; returns true once it has finished them all. A leg is
   * either a path (walked one tile per STEP_MS) or a pause, at the start of which something
   * may happen (the chef hands over a dish) and at the end of which a message is delivered.
   */
  #advance(m, t) {
    if (t < m.start) return false;
    const leg = m.legs[m.leg];
    if (!leg) return true;
    if (leg.pause !== undefined) {
      if (leg.pausedAt === undefined) {
        leg.pausedAt = t;
        leg.onStart?.();
        if (m.event?.text && leg.deliverTo) this.#say(leg.deliverTo, m.event, t);
      }
      if (t - leg.pausedAt >= leg.pause) {
        m.leg += 1;
        m.legStart = t;
      }
      m.step = 0;
      return false;
    }
    if (m.legStart === undefined) m.legStart = m.start;
    const elapsed = t - m.legStart;
    const idx = Math.floor(elapsed / STEP_MS);
    if (idx >= leg.path.length - 1) {
      m.pos = { ...leg.path[leg.path.length - 1] };
      m.step = 0;
      m.leg += 1;
      m.legStart = t;
      m.carry = leg.carry ?? null;
      return false;
    }
    const a = leg.path[idx];
    const b = leg.path[idx + 1];
    const k = (elapsed - idx * STEP_MS) / STEP_MS;
    m.pos = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    m.dir = { dx: b.x - a.x, dy: b.y - a.y };
    m.step = 1 + (Math.floor(elapsed / (STEP_MS / 2)) % 2);
    m.carry = leg.carry ?? null;
    return false;
  }

  // ── camera ────────────────────────────────────────────────────────────────────────────────

  #bounds() {
    const { w, d } = this.room;
    return {
      minX: iso(0, d).x - 24,
      maxX: iso(w, 0).x + 24,
      minY: iso(0, 0).y - WALL_H - 48,
      maxY: iso(w, d).y + 40,
    };
  }

  /** The zoom at which the whole room fits the canvas, with a little air around it. */
  fit(immediate = false) {
    const b = this.#bounds();
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const zoom = clamp(Math.min(cw / (b.maxX - b.minX), ch / (b.maxY - b.minY)) * 0.96);
    const target = {
      zoom,
      x: (b.minX + b.maxX) / 2 - cw / zoom / 2,
      y: (b.minY + b.maxY) / 2 - ch / zoom / 2,
    };
    this.zoomTarget = null;
    if (immediate) {
      this.camera = target;
      this.cameraTarget = null;
    } else this.cameraTarget = target;
  }

  #tileOfAgent(id) {
    if (id === this.hubId) return this.room.chef;
    const mover = this.movers.find((m) => m.role === 'diner' && m.id === id && m.pos);
    if (mover) return { x: Math.round(mover.pos.x), y: Math.round(mover.pos.y) };
    return this.placement.get(id)?.tile ?? null;
  }

  /** Glide the camera onto one diner (or the kitchen), or back out to the whole room. */
  focus(agentId) {
    const tile = agentId ? this.#tileOfAgent(agentId) : null;
    if (!tile) {
      this.fit();
      return;
    }
    const at = iso(tile.x + 0.5, tile.y + 0.5, 20);
    this.#glideTo(at, Math.max(this.camera.zoom, 2.4));
  }

  #glideTo(at, zoom) {
    this.zoomTarget = null;
    this.cameraTarget = {
      zoom: clamp(zoom),
      x: at.x - this.canvas.clientWidth / zoom / 2,
      y: at.y - this.canvas.clientHeight / zoom / 2,
    };
  }

  /** Nudge the zoom by a factor about a screen point; the wheel, the keys and double-click all land here. */
  zoomBy(factor, anchor = null) {
    this.cameraTarget = null;
    const base = this.zoomTarget ?? this.camera.zoom;
    this.zoomTarget = clamp(base * factor);
    this.zoomAnchor = anchor ?? { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
  }

  /**
   * Every frame the camera eases toward wherever it is headed. A wheel zoom eases the scale
   * while re-solving the pan so the world point under the cursor stays under the cursor —
   * that, more than the easing, is what makes zooming feel attached to the room.
   */
  #stepCamera() {
    if (this.zoomTarget !== null) {
      const anchor = this.zoomAnchor;
      const before = this.#toWorld(anchor.x, anchor.y);
      const next = this.camera.zoom + (this.zoomTarget - this.camera.zoom) * 0.22;
      this.camera.zoom = Math.abs(this.zoomTarget - next) < 0.002 ? this.zoomTarget : next;
      this.camera.x = before.x - anchor.x / this.camera.zoom;
      this.camera.y = before.y - anchor.y / this.camera.zoom;
      if (this.camera.zoom === this.zoomTarget) this.zoomTarget = null;
      return;
    }
    const target = this.cameraTarget;
    if (!target) return;
    const k = 0.16;
    this.camera.zoom += (target.zoom - this.camera.zoom) * k;
    this.camera.x += (target.x - this.camera.x) * k;
    this.camera.y += (target.y - this.camera.y) * k;
    if (
      Math.abs(target.x - this.camera.x) < 0.3 &&
      Math.abs(target.y - this.camera.y) < 0.3 &&
      Math.abs(target.zoom - this.camera.zoom) < 0.002
    ) {
      this.camera = { ...target };
      this.cameraTarget = null;
    }
  }

  #toScreen(wx, wy) {
    const k = this.camera.zoom;
    return { x: (wx - this.camera.x) * k, y: (wy - this.camera.y) * k };
  }

  #toWorld(sx, sy) {
    const k = this.camera.zoom;
    return { x: sx / k + this.camera.x, y: sy / k + this.camera.y };
  }

  #tileAt(sx, sy) {
    const p = this.#toWorld(sx, sy);
    const hx = TILE_W / 2;
    const hy = TILE_H / 2;
    return { x: Math.floor((p.x / hx + p.y / hy) / 2), y: Math.floor((p.y / hy - p.x / hx) / 2) };
  }

  /** Whoever is drawn under a point: figures and tables record their boxes as they draw. */
  #agentAt(sx, sy) {
    const p = this.#toWorld(sx, sy);
    for (let i = this.hitboxes.length - 1; i >= 0; i--) {
      const h = this.hitboxes[i];
      if (p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) return h.id;
    }
    return null;
  }

  // ── input ─────────────────────────────────────────────────────────────────────────────────

  #resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
  }

  #bindInput() {
    let dragging = false;
    let moved = 0;
    let last = { x: 0, y: 0 };
    const local = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = 0;
      last = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      this.pointer = local(e);
      this.hoverId = this.#agentAt(this.pointer.x, this.pointer.y);
      this.canvas.style.cursor = dragging ? 'grabbing' : this.hoverId ? 'pointer' : 'grab';
      if (!dragging) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 2) {
        this.cameraTarget = null;
        this.zoomTarget = null;
      }
      this.camera.x -= dx / this.camera.zoom;
      this.camera.y -= dy / this.camera.zoom;
      last = { x: e.clientX, y: e.clientY };
    });
    for (const event of ['pointerup', 'pointercancel']) {
      this.canvas.addEventListener(event, () => {
        dragging = false;
      });
    }
    this.canvas.addEventListener('pointerleave', () => {
      dragging = false;
      this.hoverId = null;
    });
    this.canvas.addEventListener('click', (e) => {
      if (moved >= 5) return;
      const at = local(e);
      const id = this.#agentAt(at.x, at.y);
      // Clicking the floor is not a way out: only Esc deselects, so a near-miss on a figure
      // cannot throw the camera back to the whole room.
      if (id) this.select(id);
    });
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Trackpads send many small deltas, mice a few large ones; pinch arrives as a wheel
        // with ctrlKey. Scaling by the delta keeps all three feeling the same.
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0035)), local(e));
      },
      { passive: false },
    );
    this.canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.zoomBy(1.8, local(e));
    });
  }

  select(id) {
    this.selectedId = id;
    this.focus(id);
    this.onSelect(id);
  }

  // ── rendering ─────────────────────────────────────────────────────────────────────────────

  #frame() {
    const t = this.#now();
    this.#stepCamera();
    this.#stepMovers(t);
    this.#render(t);
    requestAnimationFrame(() => this.#frame());
  }

  #render(t) {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    const byId = new Map(this.agents.map((a) => [a.id, a]));
    this.hitboxes = [];

    // The room is drawn straight onto the retina canvas at the exact zoom, never resampled:
    // vector shapes are crisp at any scale, and the figures' whole-unit cells stay square.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0e1219';
    ctx.fillRect(0, 0, cw, ch);
    const k = this.camera.zoom;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, -this.camera.x * dpr * k, -this.camera.y * dpr * k);
    if (this.room) this.#drawRoom(ctx, t, byId);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#drawGlances(ctx, t);
    this.#drawLabels(ctx, byId);
    this.#drawBubbles(ctx, t, byId);
    this.#drawTooltip(ctx, byId);
    this.#drawToasts(ctx, byId, t);
  }

  #drawRoom(b, t, byId) {
    const { w, d, gate, chef, lobbyY, entrance, podium, host } = this.room;
    void gate;
    floor(b, w, d, KITCHEN_ROWS, lobbyY + 1);
    walls(b, w, d, WALL_H);
    for (let y = 6; y < d - 2; y += 5) wallPicture(b, 0, y, -1, 40, t);
    for (let y = 9; y < d - 2; y += 5) wallLamp(b, 0, y, -1, 48, t);
    for (let x = 1; x + 2 < w; x += 5) shelf(b, x, 0, 1, 42);
    for (let x = 3; x < w - 1; x += 5) wallLamp(b, x, 0, 1, 48, t);

    // Everything on the floor, painter-sorted by depth (x+y), with a layer for ties.
    const items = [];
    const add = (x, y, layer, draw) => items.push({ depth: (x + y) * 10 + layer, draw });

    for (let x = 0; x < w; x++)
      if (x !== gate) add(x, COUNTER_Y, 5, () => counter(b, x, COUNTER_Y));
    add(gate, COUNTER_Y, 0, () => serviceBell(b, gate - 0.5, COUNTER_Y + 0.5, 18));

    const hub = byId.get(this.hubId);
    if (hub) {
      const cooking = hub.status === 'working';
      add(chef.x - 1, chef.y, 3, () => stove(b, chef.x - 1, chef.y, cooking, t));
      add(chef.x, chef.y, 5, () => this.#drawChef(b, hub, t));
    }
    const { station } = this.room;
    add(station.x, station.y, 5, () => cardTable(b, station.x, station.y, t));
    for (const wt of this.waiters) {
      const at = wt.task ? (wt.pos ?? wt.seat) : wt.seat;
      add(at.x, at.y, wt.task ? 6 : 4, () => this.#drawWaiter(b, wt, t));
    }

    // The rope line between the floor and the lobby, with a gap at the entrance.
    let prevPost = null;
    for (let x = 0; x <= w; x++) {
      if (x === entrance.x || x === entrance.x + 1) {
        prevPost = null;
        if (x === entrance.x + 1) {
          add(x, lobbyY, 2, () => ropePost(b, x, lobbyY, null));
          prevPost = { x, y: lobbyY };
        }
        continue;
      }
      const from = prevPost;
      add(x, lobbyY, 2, () => ropePost(b, x, lobbyY, from));
      prevPost = { x, y: lobbyY };
    }
    add(entrance.x, lobbyY, 1, () => doormat(b, entrance.x, lobbyY));
    add(podium.x, podium.y, 5, () => hostStand(b, podium.x, podium.y, t));
    add(host.x, host.y, 5, () => this.#drawHost(b, t));
    add(0, d - 1, 5, () => plant(b, 0, d - 1));
    add(w - 1, d - 1, 5, () => plant(b, w - 1, d - 1));
    add(w - 1, lobbyY + 1, 5, () => plant(b, w - 1, lobbyY + 1));
    add(0, COUNTER_Y + 1, 5, () => plant(b, 0, COUNTER_Y + 1));

    for (const [id, place] of this.placement) {
      const agent = byId.get(id);
      const seat = this.#seatOf(id);
      if (!agent || !seat) continue;
      const seated = place.mode === 'seated';
      add(seat.cx, seat.cy, 2, () => chair(b, seat.cx, seat.cy));
      if (seated) add(seat.cx, seat.cy, 5, () => this.#drawDiner(b, agent, seat, t));
      add(seat.tx, seat.ty, 5, () => this.#drawTable(b, agent, seat, seated, t));
      if (place.mode === 'queued') {
        add(place.tile.x, place.tile.y, 5, () => this.#drawQueued(b, agent, place.tile, t));
      }
    }
    for (const m of this.movers) {
      if (!m.pos) continue;
      add(m.pos.x, m.pos.y, 6, () => this.#drawWalker(b, m, byId));
    }

    items.sort((p, q) => p.depth - q.depth);
    for (const item of items) item.draw();
  }

  #hit(id, anchors, extra = 0) {
    this.hitboxes.push({
      id,
      x: anchors.headX - 9,
      y: anchors.headY - 12 - extra,
      w: 18,
      h: anchors.feetY - anchors.headY + 14 + extra,
    });
  }

  #person(b, agent, x, y, opts, t) {
    const look = lookFor(agent.id);
    const anchors = figure(b, x, y, dinerPalette(agent.id), { ...opts, style: look.style });
    this.anchorsOf ??= new Map();
    this.anchorsOf.set(agent.id, anchors);
    this.#hit(agent.id, anchors, 8);
    void t;
    return anchors;
  }

  #drawDiner(b, agent, seat, t) {
    b.save();
    if (this.#emphasis(agent.id) < 1) b.globalAlpha = 0.6;
    const anchors = this.#person(b, agent, seat.cx, seat.cy, { facing: 'front', z: 6 }, t);
    seat.anchors = anchors;
    if (agent.status === 'waiting') {
      const look = lookFor(agent.id);
      const raise = Math.round(Math.abs(Math.sin(t / 220)) * 2);
      b.fillStyle = look.body;
      b.fillRect(anchors.handX + 1, anchors.handY - 14 - raise, 3, 12);
      b.fillStyle = look.skin;
      b.fillRect(anchors.handX, anchors.handY - 18 - raise, 5, 5);
    }
    b.restore();
  }

  #drawTable(b, agent, seat, seated, t) {
    table(b, seat.tx, seat.ty, seated ? agent.status : 'idle', t);
    if (!seated) return;
    const c = iso(seat.tx + 0.5, seat.ty + 0.5, 12);
    this.hitboxes.push({ id: agent.id, x: c.x - 16, y: c.y - 10, w: 32, h: 20 });
    const a = seat.anchors;
    if (!a) return;
    if (agent.status === 'working') fork(b, a.handX + 2, a.handY - 2, t);
    if (agent.status === 'waiting') {
      serviceBell(b, seat.tx + 0.8, seat.ty + 0.25, 18);
      exclaim(b, a.headX + 11, a.headY - 6, t);
    }
  }

  #drawQueued(b, agent, tile, t) {
    b.save();
    if (this.#emphasis(agent.id) < 1) b.globalAlpha = 0.6;
    if (agent.status === 'exited') b.globalAlpha *= 0.5;
    this.#person(b, agent, tile.x, tile.y, { facing: 'front' }, t);
    b.restore();
  }

  #drawWalker(b, m, byId) {
    const agent = byId.get(m.id);
    if (!agent) return;
    const { dx = 0, dy = 1 } = m.dir ?? {};
    const facing = dx > 0 || dy > 0 ? 'front' : 'back';
    const flip = dx < 0 || dy > 0;
    this.#person(b, agent, m.pos.x, m.pos.y, { facing, flip, step: m.step ?? 0 }, 0);
  }

  #drawChef(b, hub, t) {
    const { chef } = this.room;
    const pal = chefPalette(hub.id);
    const pose = this.chefPose && t < this.chefPose.until ? this.chefPose : null;
    const anchors = figure(b, chef.x, chef.y, pal, { facing: 'front', hat: 'chef' });
    this.chefAnchors = anchors;
    this.#hit(hub.id, anchors, 12);
    b.fillStyle = '#e8e8e2';
    b.fillRect(anchors.headX - 4, anchors.handY - 2, 9, 9);
    b.fillStyle = '#1e1a1a';
    b.fillRect(anchors.headX - 4, anchors.handY - 2, 9, 1);
    if (pose?.type === 'handoff') {
      b.fillStyle = pal.b;
      b.fillRect(anchors.handX, anchors.handY - 6, 8, 3);
      tray(b, anchors.handX + 10, anchors.handY - 6, 'send');
    } else if (hub.status === 'working') {
      const stir = t / 300;
      const sx = anchors.headX - 12 + Math.round(Math.cos(stir) * 2);
      const sy = anchors.handY - 4 + Math.round(Math.sin(stir) * 1.5);
      b.fillStyle = pal.b;
      b.fillRect(sx + 2, sy + 1, 6, 3);
      b.fillStyle = '#c9a227';
      b.fillRect(sx, sy - 8, 1, 9);
      b.fillRect(sx - 1, sy - 9, 3, 2);
    }
  }

  #drawHost(b, t) {
    const { host } = this.room;
    const pal = hostPalette();
    const anchors = figure(b, host.x, host.y, pal, { facing: 'front' });
    b.fillStyle = '#1e1a1a';
    b.fillRect(anchors.headX - 2, anchors.headY + 12, 4, 2); // bow tie
    const waving = this.hostPose && t < this.hostPose.until;
    if (waving) {
      const wag = Math.round(Math.sin(t / 90) * 2);
      b.fillStyle = pal.b;
      b.fillRect(anchors.handX + 1, anchors.handY - 14, 3, 12);
      b.fillStyle = '#f0c9a4';
      b.fillRect(anchors.handX + wag, anchors.handY - 19, 5, 5);
    }
  }

  #drawWaiter(b, wt, t) {
    const busy = Boolean(wt.task);
    const at = busy ? (wt.pos ?? wt.seat) : wt.seat;
    const { dx = 0, dy = 1 } = wt.dir ?? {};
    const facing = busy && (dx < 0 || dy < 0) ? 'back' : 'front';
    const flip = busy && (dx < 0 || dy > 0);
    const anchors = figure(b, at.x, at.y, wt.pal, {
      facing,
      flip,
      step: busy ? (wt.step ?? 0) : 0,
      z: busy ? 0 : 6,
    });
    b.fillStyle = '#d9413b';
    b.fillRect(anchors.headX - 2, anchors.headY + 12, 4, 2); // bow tie
    if (wt.carry) tray(b, anchors.handX, anchors.handY - 2, wt.carry);
    if (!busy) {
      // A hand of cards held up while waiting for an order.
      const fan = Math.sin(t / 700 + wt.index) > 0.6 ? 1 : 0;
      b.fillStyle = '#ffffff';
      b.fillRect(anchors.handX - 2, anchors.handY - 6 - fan, 4, 5);
      b.fillRect(anchors.handX + 1, anchors.handY - 7 - fan, 4, 5);
      b.fillStyle = wt.index % 2 ? '#d9413b' : '#26262b';
      b.fillRect(anchors.handX - 1, anchors.handY - 5 - fan, 1, 1);
      b.fillRect(anchors.handX + 3, anchors.handY - 6 - fan, 1, 1);
    }
  }

  #emphasis(id) {
    const focus = this.hoverId ?? this.selectedId;
    if (!focus) return 1;
    return id === focus ? 1 : 0.5;
  }

  // ── screen-space overlays ─────────────────────────────────────────────────────────────────

  #headScreen(id) {
    if (id === this.hubId && this.chefAnchors)
      return this.#toScreen(this.chefAnchors.headX, this.chefAnchors.headY - 8);
    const a = this.anchorsOf?.get(id);
    return a ? this.#toScreen(a.headX, a.headY) : null;
  }

  #drawGlances(ctx, t) {
    this.glances = this.glances.filter((g) => t < g.until);
    for (const glance of this.glances) {
      const to = this.#headScreen(glance.workerId);
      const from = this.#headScreen(this.hubId);
      if (!to || !from) continue;
      const k = (t - glance.start) / (glance.until - glance.start);
      ctx.save();
      ctx.globalAlpha = 0.9 * Math.sin(k * Math.PI);
      ctx.strokeStyle = KIND_COLOR.read;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(to.x, to.y, 14 + k * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  #drawLabels(ctx, byId) {
    if (!this.room) return;
    const zoomedIn = this.camera.zoom >= 2;
    const focus = this.hoverId ?? this.selectedId;
    const draw = (agent, at, isHub, conn, tight) => {
      const status = STATUS[agent.status] ?? STATUS.idle;
      const full = focus === agent.id || isHub;
      const issue = issueOf(agent.name, agent.branch);
      const limit = full ? 34 : tight ? 14 : 20;
      const shown = issue.key ? `${issue.key}  ${issue.title}` : agent.name;
      const name = shown.length > limit ? `${shown.slice(0, limit - 1)}…` : shown;
      const count = conn && (!tight || full) ? conn.sends + conn.replies : 0;
      const nameFont = full
        ? '600 12.5px ui-sans-serif, system-ui, sans-serif'
        : '600 10.5px ui-sans-serif, system-ui, sans-serif';
      ctx.save();
      ctx.globalAlpha = 0.6 + 0.4 * this.#emphasis(agent.id);
      ctx.textBaseline = 'middle';
      ctx.font = nameFont;
      const nameW = ctx.measureText(name).width;
      ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
      const countText = count ? `✉ ${count}` : '';
      const countW = countText ? ctx.measureText(countText).width + 10 : 0;
      ctx.font = '500 10.5px ui-monospace, SFMono-Regular, monospace';
      const sub = [status.label, agent.model].filter(Boolean).join('  ·  ');
      const subW = full ? ctx.measureText(sub).width : 0;
      const badge = full ? 14 : 11;
      const width = Math.max(nameW + countW + badge + 6, subW) + 28;
      const height = full ? 40 : 20;
      const x = at.x - width / 2;
      const y = at.y - height;
      ctx.fillStyle = isHub ? 'rgba(38,28,58,0.94)' : 'rgba(13,18,26,0.9)';
      ctx.strokeStyle =
        this.selectedId === agent.id
          ? '#ffd166'
          : isHub
            ? 'rgba(199,146,234,0.8)'
            : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = this.selectedId === agent.id ? 1.6 : 1;
      roundRect(ctx, x, y, width, height, 6);
      ctx.fill();
      ctx.stroke();
      // Little tail down to the head it belongs to.
      ctx.beginPath();
      ctx.moveTo(at.x - 4, y + height);
      ctx.lineTo(at.x, y + height + 5);
      ctx.lineTo(at.x + 4, y + height);
      ctx.closePath();
      ctx.fillStyle = isHub ? 'rgba(38,28,58,0.94)' : 'rgba(13,18,26,0.9)';
      ctx.fill();
      logoVector(ctx, x + 7, y + (full ? 6 : 4.5), badge, agent.flavor);
      ctx.fillStyle = status.color;
      ctx.beginPath();
      ctx.arc(x + badge + 14, y + (full ? 13 : 10), 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#eef3f9';
      ctx.font = nameFont;
      ctx.textAlign = 'left';
      ctx.fillText(name, x + badge + 20, y + (full ? 13 : 10));
      if (countText) {
        ctx.font = '700 10px ui-monospace, SFMono-Regular, monospace';
        ctx.fillStyle = KIND_COLOR.send;
        ctx.textAlign = 'right';
        ctx.fillText(countText, x + width - 8, y + (full ? 13 : 10));
      }
      if (full) {
        ctx.font = '500 10.5px ui-monospace, SFMono-Regular, monospace';
        ctx.fillStyle = status.color;
        ctx.textAlign = 'center';
        ctx.fillText(sub, at.x, y + 28);
      }
      if (isHub) {
        ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        const tag = 'CHEF · ORCHESTRATOR';
        const tw = ctx.measureText(tag).width + 14;
        roundRect(ctx, at.x - tw / 2, y - 11, tw, 16, 8);
        ctx.fillStyle = '#c792ea';
        ctx.fill();
        ctx.fillStyle = '#1a1226';
        ctx.fillText(tag, at.x, y - 3);
      }
      ctx.restore();
    };

    // Every name floats over its own head. The line at the door is dense, so zoomed out only
    // the person under the cursor gets one there.
    const k = this.camera.zoom;
    for (const [id, place] of this.placement) {
      const agent = byId.get(id);
      const head = this.#headScreen(id);
      if (!agent || !head) continue;
      if (place.mode === 'queued' && !zoomedIn && focus !== id) continue;
      draw(agent, { x: head.x, y: head.y - 14 * k - 4 }, false, this.conns.get(id), !zoomedIn);
    }
    const hub = byId.get(this.hubId);
    const hubAt = this.#headScreen(this.hubId);
    if (hub && hubAt && focus === hub.id)
      draw(hub, { x: hubAt.x, y: hubAt.y - 14 * k - 6 }, true, null, false);
  }

  /** Habbo speech bubbles: white, black text, a little tail toward the speaker, stacked upward. */
  #drawBubbles(ctx, t, byId) {
    for (const [id, stack] of this.bubbles) {
      const live = stack.filter((b) => t < b.until);
      if (!live.length) {
        this.bubbles.delete(id);
        continue;
      }
      this.bubbles.set(id, live);
      const at = this.#headScreen(id);
      if (!at) continue;
      let bottom = at.y - 22;
      // Newest nearest the head; older ones pushed up the stack.
      for (let i = live.length - 1; i >= 0; i--) {
        const bubble = live[i];
        if (t < bubble.start) continue;
        ctx.save();
        ctx.font = '500 11.5px ui-sans-serif, system-ui, sans-serif';
        const lines = wrapText(ctx, bubble.text, 200, i === live.length - 1 ? 3 : 2);
        ctx.font = '700 9.5px ui-monospace, SFMono-Regular, monospace';
        const header = this.#bubbleHeader(bubble.event, byId);
        const headerW = ctx.measureText(header).width;
        ctx.font = '500 11.5px ui-sans-serif, system-ui, sans-serif';
        const width =
          Math.max(
            Math.min(200, Math.max(...lines.map((l) => ctx.measureText(l).width))),
            headerW,
          ) + 20;
        const height = lines.length * 15 + 28;
        const fade = Math.min(1, (bubble.until - t) / 600, (t - bubble.start) / 200);
        ctx.globalAlpha = Math.max(0, fade) * (i === live.length - 1 ? 1 : 0.8);
        const x = at.x + 14;
        const y = bottom - height;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = KIND_COLOR[bubble.kind] ?? '#1e1a1a';
        ctx.lineWidth = 1.5;
        roundRect(ctx, x, y, width, height, 6);
        ctx.fill();
        ctx.stroke();
        if (i === live.length - 1) {
          ctx.beginPath();
          ctx.moveTo(x + 4, y + height - 2);
          ctx.lineTo(x - 6, y + height + 8);
          ctx.lineTo(x + 14, y + height - 2);
          ctx.closePath();
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }
        ctx.fillStyle = KIND_COLOR[bubble.kind] === '#5ee08a' ? '#1f7a3f' : '#8a6a12';
        ctx.font = '700 9.5px ui-monospace, SFMono-Regular, monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(header, x + 10, y + 7);
        ctx.fillStyle = '#161c26';
        ctx.font = '500 11.5px ui-sans-serif, system-ui, sans-serif';
        lines.forEach((line, k) => ctx.fillText(line, x + 10, y + 21 + k * 15));
        ctx.restore();
        bottom = y - 6;
      }
    }
  }

  #drawTooltip(ctx, byId) {
    const id = this.hoverId;
    if (!id || id === this.selectedId) return;
    const agent = byId.get(id);
    if (!agent) return;
    const status = STATUS[agent.status] ?? STATUS.idle;
    const conn = this.conns.get(id);
    const place = this.placement.get(id);
    ctx.save();
    ctx.font = '500 11.5px ui-sans-serif, system-ui, sans-serif';
    const lines = agent.says ? wrapText(ctx, agent.says, 230, 3) : [];
    const where =
      place?.mode === 'queued'
        ? 'in line at the door'
        : place?.mode === 'walking'
          ? 'on the way'
          : null;
    const wrap = (text, font, color, max) => {
      ctx.font = font;
      return wrapText(ctx, text, 236, max).map((line) => ({ text: line, font, color }));
    };
    const rows = [
      ...wrap(agent.name, '600 13px ui-sans-serif, system-ui, sans-serif', '#eef3f9', 2),
      ...wrap(
        [status.sub, where, agent.activity, agent.model].filter(Boolean).join(' · '),
        '500 10.5px ui-monospace, SFMono-Regular, monospace',
        status.color,
        2,
      ),
      ...(conn
        ? [
            {
              text: `${conn.sends} dishes served · ${conn.replies} sent back · ${conn.reads} check-ins`,
              font: '500 10.5px ui-monospace, SFMono-Regular, monospace',
              color: '#8b9cb3',
            },
          ]
        : []),
      ...lines.map((l) => ({
        text: l,
        font: 'italic 500 11.5px ui-sans-serif, system-ui, sans-serif',
        color: '#c9d4e2',
      })),
      {
        text: 'click to open the thread',
        font: '500 10px ui-sans-serif, system-ui',
        color: '#6f7f95',
      },
    ];
    let width = 0;
    for (const row of rows) {
      ctx.font = row.font;
      width = Math.max(width, ctx.measureText(row.text).width);
    }
    width = Math.min(width, 240) + 26;
    const height = rows.length * 17 + 16;
    let x = this.pointer.x + 18;
    let y = this.pointer.y + 18;
    if (x + width > this.canvas.clientWidth - 10) x = this.pointer.x - width - 12;
    if (y + height > this.canvas.clientHeight - 10) y = this.pointer.y - height - 12;
    ctx.fillStyle = 'rgba(11,15,22,0.96)';
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, width, height, 9);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = 'middle';
    rows.forEach((row, i) => {
      ctx.font = row.font;
      ctx.fillStyle = row.color;
      ctx.fillText(row.text, x + 13, y + 16 + i * 17);
    });
    ctx.restore();
  }

  #drawToasts(ctx, byId, t) {
    this.toasts = this.toasts.filter((toast) => t < toast.until);
    const live = this.toasts.filter((toast) => t >= toast.start).slice(-3);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    let bottom = h - 56;
    for (let i = live.length - 1; i >= 0; i--) {
      const toast = live[i];
      const { event } = toast;
      const from = byId.get(event.fromId)?.name ?? 'someone';
      const to = byId.get(event.toId)?.name ?? 'someone';
      const header =
        event.kind === 'report'
          ? `${short(from)}  sent word back to the kitchen`
          : `${short(from)}  →  ${short(to)}`;
      ctx.save();
      ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
      const lines = wrapText(ctx, event.text, 460, 2);
      const width = 520;
      const height = 34 + lines.length * 16;
      const x = w / 2 - width / 2;
      const y = bottom - height;
      const fade = Math.min(1, (toast.until - t) / 500, (t - toast.start) / 250);
      ctx.globalAlpha = Math.max(0, fade) * (i === live.length - 1 ? 1 : 0.55);
      ctx.fillStyle = 'rgba(11,15,22,0.96)';
      ctx.strokeStyle = KIND_COLOR[event.kind] ?? KIND_COLOR.send;
      ctx.lineWidth = 1.2;
      roundRect(ctx, x, y, width, height, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = KIND_COLOR[event.kind] ?? KIND_COLOR.send;
      ctx.font = '700 10.5px ui-monospace, SFMono-Regular, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(header, x + 14, y + 15);
      ctx.fillStyle = '#eef3f9';
      ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
      lines.forEach((line, k) => ctx.fillText(line, x + 14, y + 34 + k * 16));
      ctx.restore();
      bottom = y - 8;
    }
  }
}

function clamp(zoom) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function short(name) {
  return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}
