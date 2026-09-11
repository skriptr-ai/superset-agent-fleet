// One restaurant, and the street it stands on.
//
// The room is the whole fleet, and it is read in two halves.
//
// **The bar is the orchestration.** An orchestrator is the bartender; the sessions it has been
// observed driving are the ones on the stools in front of it, and every message between them
// goes straight across the bar — a drink poured out, an empty glass slid back. Several
// orchestrators run at once, so the bar is divided into patches, one per bartender, laid left
// to right in the order they were elected. A bar with nobody behind it is still a bar.
//
// **The dining room is yours.** The chef in the kitchen is the developer — you — and every
// session nobody is orchestrating is a customer at a table, waiting on you rather than on an
// agent. When you send one of them something, a waiter carries it out of the kitchen to that
// table; when one finishes a turn, a waiter brings the note back to the pass.
//
// The room is a cutaway: no roof, no front wall, the whole floor in view. Everything with a
// position lives on one tile grid; anyone who moves walks it tile by tile along a BFS path.
// Everything is drawn straight onto the retina canvas at the current zoom, so it is crisp at
// any scale and zooming is continuous.

import {
  iso,
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
  bartenderPalette,
  waiterPalette,
  hostPalette,
  lookFor,
  logoVector,
  cardTable,
  tray,
  barCounter,
  bottleShelf,
  barTaps,
  duckboard,
  wallWindow,
  BAR_H,
  DUCKBOARD_H,
  stool,
  drink,
  exclaim,
  fork,
  roundRect,
  wrapText,
  issueOf,
  STATUS,
  KIND_COLOR,
  PHASE_COLOR,
  plainActivity,
  taskTitle,
} from './draw.js';
import {
  buildDistrict,
  COUNTER_Y,
  KITCHEN_ROWS,
  FLOOR_X,
  FIRST_TABLE_Y,
  ENTRANCE_X,
  HOUSE_WALL_H,
} from './district.js';
import {
  buildGround,
  drawGround,
  restaurantTerrace,
  houseSilhouette,
  streetProp,
  car,
} from './street.js';
import { drawCityGround, cityObjects, cityStreetProps, drawQuay } from './city.js';
import { Lighting, lightAt, pinnedTime, DEFAULT_PLACE } from './daylight.js';
import { drawWeather, drawCloudShadows } from './weather.js';

const WALL_H = HOUSE_WALL_H;
/**
 * Screen pixels per world unit. The floor is the opening view: that shows the restaurant and
 * the two blocks round it, and the camera can go closer but never further out. It is set when
 * the room is built and again whenever the window changes shape.
 */
const ZOOM_FLOOR = 0.32;
const ZOOM_MAX = 6;

/** How long a car takes to cross the district's own frontage; the city road is longer pro rata. */
const CAR_PERIOD = 21_000;
/** Cars in each lane of the main road at once, evenly spaced along it. */
const CARS_PER_LANE = 4;

/** How far behind the back walls the opening view reaches, in world units: the blocks behind. */
const BACK_PEEK = 250;
/** How far past the frontage the opening view reaches, in world units: the road and the quay. */
const FRONT_PEEK = 40;
/** Where the restaurant's centre sits down the canvas in the opening view: a touch below the middle. */
const ROOM_CENTRE = 0.54;

/** The name over the door. There is one restaurant, so there is one name. */
const HOUSE_NAME = 'The Orchestra';

/** A session must be seen driving this many peers of its own to be a second orchestrator. */
const SECOND_HUB_MIN = 2;

/** More bartenders than this and the bar runs off the end of the room. */
const MAX_BARTENDERS = 4;

/**
 * A spawn means two different things depending on whether anyone sent it.
 *
 * With a sender it is an orchestrator starting a worker and handing it its opening brief — a
 * message, and usually the longest and most consequential one of the whole run. Without a
 * sender it is a session that simply appeared in the fleet, and its `text` is the workspace's
 * NAME rather than anything anybody said; putting that over a head reads as somebody
 * announcing their own name, and on a machine where workspaces come and go, as a wall of them.
 */
export const isBriefing = (event) =>
  event.kind === 'spawn' && Boolean(event.fromId) && Boolean(event.text);

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
/** How long a glass takes to travel the bar, and how long it sits there once it lands. */
const POUR_MS = 520;
const POUR_HOLD = 900;

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
    /** Every orchestrator the server elected; each one gets a patch of the bar. */
    this.hubIds = [];
    this.links = [];
    this.shapeSignature = '';
    this.district = null;
    this.ground = null;
    /** The restaurant: its plan, its kitchen crew, its bar patches and its order book. */
    this.room = null;
    /** workspaceId → the bartender driving it, and which stool of that patch it has */
    this.barOf = new Map();
    this.stoolOf = new Map();
    /** workspaceId → index of the table it has been given */
    this.tableOf = new Map();
    /** Whoever could not be seated, in the order they arrived. */
    this.queue = [];
    this.placement = new Map();
    this.blocked = new Set();
    this.blockedStaff = new Set();
    this.movers = [];
    /** Glasses in transit along the bar, each carrying one message. */
    this.pours = [];
    this.hitboxes = [];
    this.glances = [];
    this.bubbles = new Map();
    this.toasts = [];
    this.selectedId = null;
    this.hoverId = null;
    this.hoverRoom = false;
    this.pointer = { x: 0, y: 0 };
    this.showReads = true;
    this.onSelect = () => {};
    this.needsFit = true;
    /** The opening view, which is also the furthest the camera may go: see ZOOM_FLOOR. */
    this.home = null;
    /** Override to freeze or scrub the animation clock; null means real time. */
    this.clock = null;
    /**
     * The sky. The town is drawn for the night and lit up to the hour by the tone map; the
     * place is where the sun is worked out over, the weather what it has to get through.
     * `pinnedAt` is a moment from the URL to draw instead of now, for looking at a night.
     */
    this.lighting = new Lighting(this.ctx);
    this.place = DEFAULT_PLACE;
    this.weather = null;
    this.pinnedAt = pinnedTime(window.location.search);
    this.light = lightAt(this.pinnedAt ?? new Date(), this.place, null);

    this.#bindInput();
    this.#resize();
    window.addEventListener('resize', () => {
      this.#resize();
      // The window's new shape gives the opening view a new size; whatever the camera was
      // doing, it must still be inside it.
      if (this.room) this.#rehome();
    });
    requestAnimationFrame(() => this.#frame());
  }

  #now() {
    return this.clock ? this.clock() : performance.now();
  }

  // ── the sky ───────────────────────────────────────────────────────────────────────────────

  /** Where the town is, as the server says: the sun is worked out over it from now on. */
  setPlace(place) {
    if (place?.tz && Number.isFinite(place.lat) && Number.isFinite(place.lon)) this.place = place;
    this.pinnedAt = pinnedTime(window.location.search, this.place);
  }

  /** The weather over the town, as lib/weather.js summarised it; null draws clear skies. */
  setWeather(weather) {
    this.weather = weather ?? null;
  }

  /** The moment being drawn: pinned by the URL, or now. */
  skyTime() {
    return this.pinnedAt ?? new Date();
  }

  // ── world state ───────────────────────────────────────────────────────────────────────────

  setWorld(agents, hubIds, links) {
    this.agents = agents;
    // The server sends every orchestrator it has elected, most-driving first. A single id is
    // still accepted so an older server, or a console poke, keeps working.
    this.hubIds = Array.isArray(hubIds) ? hubIds : hubIds ? [hubIds] : [];
    this.links = links ?? [];
    this.#layout();
    if (this.needsFit && this.room) {
      this.fit(true);
      this.needsFit = false;
    } else if (this.room) this.#rehome();
  }

  /**
   * Every orchestrator behind the bar, longest-standing first.
   *
   * The server elects them from evidence the browser cannot see: commands read off screens over
   * many polls, messages an orchestrator wrote down itself, and the MCP calls its harness
   * recorded. It also distinguishes commanding a peer from merely reading its screen. So when it
   * names any at all, those names win.
   *
   * The derivation below only ever adds to a server that named one. It looks for a second in the
   * link tally — any other live session driving two or more peers of its own that the first is
   * not already driving. Such a session is nobody's worker, so it earns its own patch of bar
   * rather than a stool at somebody else's. It counts any link as driving, reads included, which
   * is the looser rule the server has since dropped, so it is not allowed to elect a third.
   */
  #electHubs() {
    const alive = new Set(this.agents.map((a) => a.id));
    const elected = this.hubIds.filter((id) => alive.has(id));
    if (elected.length > 1) return elected.slice(0, MAX_BARTENDERS);

    const first = elected[0] ?? null;
    if (!first) return [];
    const driven = new Set(this.links.filter((l) => l.fromId === first).map((l) => l.toId));
    const fan = new Map();
    for (const link of this.links) {
      if (link.fromId === link.toId) continue;
      if (!alive.has(link.fromId) || !alive.has(link.toId)) continue;
      if (!fan.has(link.fromId)) fan.set(link.fromId, new Set());
      fan.get(link.fromId).add(link.toId);
    }
    let second = null;
    let best = SECOND_HUB_MIN - 1;
    for (const [id, peers] of fan) {
      // A session the first orchestrator drives is its worker, whatever else it gets up to.
      if (id === first || driven.has(id)) continue;
      const score = [...peers].filter((p) => p !== first && !driven.has(p)).length;
      if (score > best) {
        best = score;
        second = id;
      }
    }
    return second ? [first, second] : [first];
  }

  /**
   * One record per worker of `hubId`, both directions folded together. A worker is a session the
   * orchestrator has DRIVEN — a link outbound from it. The reverse direction alone does not
   * qualify: a session that merely read an orchestrator's screen is not one of its workers.
   */
  #connsFor(hubId, taken) {
    const conns = new Map();
    if (!hubId) return conns;
    const driven = new Set(this.links.filter((l) => l.fromId === hubId).map((l) => l.toId));
    for (const link of this.links) {
      const worker = link.fromId === hubId ? link.toId : link.fromId;
      if (worker === hubId || !driven.has(worker)) continue;
      if (link.fromId !== hubId && link.toId !== hubId) continue;
      if (taken?.has(worker)) continue;
      const conn = conns.get(worker) ?? {
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
      conns.set(worker, conn);
    }
    return conns;
  }

  /** Live sessions that share a Superset sidebar folder — a tag — with `hubId`. */
  #folderMatesOf(hubId) {
    const tags = new Set(this.agents.find((a) => a.id === hubId)?.tags ?? []);
    if (!tags.size) return [];
    return this.agents
      .filter((a) => a.id !== hubId && (a.tags ?? []).some((t) => tags.has(t)))
      .map((a) => a.id);
  }

  /** The patch of bar this session is pouring behind, if it is a bartender at all. */
  #patchOfHub(id) {
    return this.room?.patches.find((patch) => patch.hubId === id) ?? null;
  }

  /** The patch this session is sitting at, if it is on a stool. */
  #patchOfWorker(id) {
    const hubId = this.barOf.get(id);
    return hubId ? this.#patchOfHub(hubId) : null;
  }

  #stoolTileOf(id) {
    const patch = this.#patchOfWorker(id);
    const index = this.stoolOf.get(id);
    return patch && index !== undefined ? (patch.stools[index] ?? null) : null;
  }

  /** What this session's own bartender has exchanged with it. */
  #connOf(id) {
    for (const patch of this.room?.patches ?? []) {
      const conn = patch.conns.get(id);
      if (conn) return conn;
    }
    return null;
  }

  #seatOf(id) {
    const slot = this.room?.plan.slots[this.tableOf.get(id)];
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

  /** Where the n-th person in the line stands, wrapping to another row if the lobby fills up. */
  #queueTile(index) {
    const { ox, w, lobbyY, d } = this.room.plan;
    const perRow = Math.max(1, Math.floor((w - ENTRANCE_X - 1) / 2));
    return {
      x: ox + ENTRANCE_X + 2 * (index % perRow),
      y: Math.min(lobbyY + 2 + Math.floor(index / perRow), d - 1),
    };
  }

  /**
   * How big the room wants to be, quantised in steps. Rebuilding re-seats everyone where they
   * stand and throws away whatever walk was in progress — including the one walk that matters
   * most, a session crossing the floor because it has just been picked up — so sizing to every
   * single arrival would rebuild the world at exactly the wrong moment.
   */
  #shapeOf(barSpec, tables) {
    const seats = Math.max(6, Math.ceil((tables + 2) / 4) * 4);
    const bar = barSpec.map((patch) => `${patch.hubId}:${patch.stools}`).join(',');
    return { seats, signature: `${bar}|${seats}` };
  }

  /** Build the room and the street it fronts, at the size the fleet currently needs. */
  #buildDistrict(barSpec, seats) {
    const plan = buildDistrict({ house: { key: 'house', name: HOUSE_NAME, seats, bar: barSpec } });
    this.district = plan;
    this.ground = buildGround(plan);
    this.blocked = plan.blocked;
    this.blockedStaff = plan.blockedStaff;
    this.room = {
      plan: plan.house,
      silhouette: houseSilhouette(plan.house),
      orders: [],
      chefPose: null,
      hostPose: null,
      tenderPose: new Map(),
      patches: plan.house.bar.patches.map((patch) => ({
        ...patch,
        conns: new Map(),
        workers: [],
      })),
      waiters: plan.house.waiterSeats.slice(0, WAITERS).map((seat, index) => ({
        index,
        seat,
        pal: waiterPalette(index),
        task: null,
        pos: null,
      })),
    };
    this.barOf = new Map();
    this.stoolOf = new Map();
    this.tableOf = new Map();
    this.queue = [];
    this.placement = new Map();
    this.movers = [];
    this.pours = [];
  }

  /**
   * Who is behind the bar, who is on a stool, who is at a table and who is still in the line.
   *
   * A stool belongs to one bartender's patch and is kept for as long as that bartender keeps
   * driving the session; a table is given once and kept for the whole run. Nobody is ever
   * outside: the street is scenery now, and the only overflow is the line at the door.
   */
  #layout() {
    const hubIds = this.#electHubs();
    const hubSet = new Set(hubIds);
    const alive = new Set(this.agents.map((a) => a.id));

    // Election order is precedence: a session two orchestrators have both driven belongs to the
    // longest-standing of them, and only what is left over can fill the patch next to it.
    const claimed = new Set(hubSet);
    const crews = [];
    for (const hubId of hubIds) {
      const conns = this.#connsFor(hubId, claimed);
      const workers = [...conns.keys()].filter((id) => alive.has(id) && !hubSet.has(id));
      // A session filed in the bartender's folder is on its crew whether or not a message
      // between them has been seen yet: the tag is the orchestrator saying so. It takes a
      // stool without a conn — nothing has been exchanged — and gets one the moment it has.
      for (const id of this.#folderMatesOf(hubId)) {
        if (hubSet.has(id) || claimed.has(id) || workers.includes(id)) continue;
        workers.push(id);
      }
      for (const id of workers) claimed.add(id);
      crews.push({ hubId, conns, workers });
    }

    const guests = this.agents.filter((a) => !hubSet.has(a.id));
    const tables = guests.filter((a) => !claimed.has(a.id)).length;
    const barSpec = crews.map((crew) => ({
      hubId: crew.hubId,
      stools: Math.max(3, Math.ceil(crew.workers.length / 3) * 3),
    }));
    const shape = this.#shapeOf(barSpec, tables);

    if (!this.district || shape.signature !== this.shapeSignature) {
      this.#buildDistrict(barSpec, shape.seats);
      this.shapeSignature = shape.signature;
    }
    const fresh = this.placement.size === 0;
    for (const patch of this.room.patches) {
      patch.conns = crews.find((crew) => crew.hubId === patch.hubId)?.conns ?? new Map();
      patch.workers = [];
    }

    for (const id of [...this.placement.keys()]) {
      if (!alive.has(id)) this.#forget(id);
    }

    // ── the stools ──────────────────────────────────────────────────────────────────────────
    // Anyone no longer driven by the bartender whose stool they are on gives it up first, so
    // the seat is free before the next round of claims goes looking for one.
    const stillDriven = new Map();
    for (const crew of crews) for (const id of crew.workers) stillDriven.set(id, crew.hubId);
    for (const id of [...this.barOf.keys()]) {
      if (stillDriven.get(id) === this.barOf.get(id)) continue;
      this.barOf.delete(id);
      this.stoolOf.delete(id);
    }

    for (const crew of crews) {
      const patch = this.room.patches.find((p) => p.hubId === crew.hubId);
      if (!patch) continue; // no bar left for this one; its workers take tables instead
      const taken = new Set();
      for (const id of crew.workers) {
        if (this.barOf.get(id) === crew.hubId) taken.add(this.stoolOf.get(id));
      }
      for (const id of crew.workers) {
        if (this.barOf.has(id)) continue;
        let index = 0;
        while (taken.has(index)) index += 1;
        if (index >= patch.stools.length) continue;
        taken.add(index);
        this.barOf.set(id, crew.hubId);
        this.stoolOf.set(id, index);
        this.tableOf.delete(id);
      }
      patch.workers = crew.workers.filter((id) => this.barOf.get(id) === crew.hubId);
    }

    // ── the tables ──────────────────────────────────────────────────────────────────────────
    const diners = guests.filter((a) => !this.barOf.has(a.id));
    const seated = new Set();
    for (const [id, slot] of this.tableOf) {
      if (this.barOf.has(id)) continue;
      seated.add(slot);
    }
    for (const agent of diners) {
      if (this.tableOf.has(agent.id)) continue;
      const slot = this.room.plan.slots.findIndex((_, i) => !seated.has(i));
      if (slot === -1) break; // full house: the rest wait at the podium
      this.tableOf.set(agent.id, slot);
      seated.add(slot);
    }

    // ── the line at the door ────────────────────────────────────────────────────────────────
    // A session that is resting is not in the room at all: it is outside the rope, waiting to be
    // shown in. That is the whole point of the line — the floor and the bar show work actually
    // happening, and the line shows the backlog waiting on somebody to start it.
    const line = [];
    for (const agent of guests) {
      const resting = agent.status === 'idle' || agent.status === 'exited';
      const hasSeat = Boolean(this.#stoolTileOf(agent.id) ?? this.#seatOf(agent.id));
      if (resting || !hasSeat) line.push(agent.id);
    }
    const waiting = new Set(line);
    this.queue = this.queue.filter((id) => waiting.has(id));
    for (const id of line) {
      if (this.queue.includes(id)) continue;
      // Joining the back of the line, the way a queue works: nobody already in it has to move.
      this.queue.push(id);
      if (!fresh) this.room.hostPose = { type: 'wave', until: this.#now() + GREET_MS };
    }

    // ── putting everybody where they belong ─────────────────────────────────────────────────
    for (const hubId of hubIds) {
      const patch = this.#patchOfHub(hubId);
      const agent = this.agents.find((a) => a.id === hubId);
      if (patch && agent) this.#place(agent, 'tending', patch.tender, fresh);
    }
    for (const agent of guests) {
      const index = this.queue.indexOf(agent.id);
      if (index >= 0) {
        this.#place(agent, 'queued', this.#queueTile(index), fresh);
        continue;
      }
      const stoolTile = this.#stoolTileOf(agent.id);
      if (stoolTile) {
        this.#place(agent, 'stool', stoolTile, fresh);
        continue;
      }
      const seat = this.#seatOf(agent.id);
      if (seat) this.#place(agent, 'seated', { x: seat.cx, y: seat.cy }, fresh);
    }
  }

  /**
   * Put somebody where they belong — walking them there if they were already somewhere else.
   *
   * Somebody the room has never seen before comes in through the front door and is greeted at
   * the podium, unless this is the very first layout, when everyone is simply already in place:
   * a page opened onto a running fleet should show a full restaurant, not a stampede.
   *
   * A bartender is the one person who never walks to their station. Electing one changes the
   * shape of the bar, which rebuilds the room, which puts everybody down where they stand — so
   * a new bartender is always placed rather than walked, and never has to find a way in behind
   * its own counter.
   */
  #place(agent, mode, tile, fresh) {
    const cur = this.placement.get(agent.id);
    if (!cur) {
      if (fresh) {
        this.placement.set(agent.id, { mode, tile });
        return;
      }
      this.room.hostPose = { type: 'wave', until: this.#now() + GREET_MS };
      this.#walk(agent, this.room.plan.door, tile, mode);
      return;
    }
    if (cur.mode === 'walking') return;
    if (cur.mode === mode && cur.tile.x === tile.x && cur.tile.y === tile.y) return;
    this.#walk(agent, cur.tile, tile, mode);
  }

  #forget(id) {
    this.barOf.delete(id);
    this.stoolOf.delete(id);
    this.tableOf.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
    this.placement.delete(id);
    this.movers = this.movers.filter((m) => m.id !== id);
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

  /**
   * Shortest walk between two tiles, avoiding the furniture, the kitchen and the back of the
   * bar — which is what routes a session picked up mid-service around the tables and along the
   * front of the bar to its stool, rather than straight through the counter.
   */
  #path(from, to, allow = new Set(), staff = false) {
    const { w, d } = this.district;
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

  // ── traffic between people ────────────────────────────────────────────────────────────────

  /**
   * Every message finds its own route across the room.
   *
   * Between a bartender and one of its own stools it goes over the bar, because that is the
   * whole distance between them. Between the kitchen and a table it goes on a tray, because
   * that is the whole distance between YOU and a session nobody is orchestrating. Anything else
   * — two sessions talking to each other, a message to somebody still in the line — is simply
   * spoken where it landed.
   */
  addEvents(events) {
    const now = this.#now();
    if (!this.room) return;
    for (const event of events) {
      const fromPatch = event.fromId ? this.#patchOfHub(event.fromId) : null;
      const toPatch = event.toId ? this.#patchOfHub(event.toId) : null;
      // Only actual traffic gets a speech bubble. An unattributed spawn and a gone carry the
      // workspace's NAME as their text — see isBriefing for why that must not be spoken.
      const carries =
        event.kind === 'send' ||
        event.kind === 'inbox' ||
        event.kind === 'report' ||
        isBriefing(event);

      if (event.kind === 'read' && fromPatch && this.#stoolTileOf(event.toId)) {
        if (this.showReads) {
          this.glances.push({
            hubId: event.fromId,
            workerId: event.toId,
            start: now,
            until: now + GLANCE_MS,
          });
        }
        continue;
      }

      // Over the bar, in whichever direction it is going.
      if (fromPatch && this.barOf.get(event.toId) === event.fromId && carries) {
        this.#pour(fromPatch, event.toId, event, 'send', now);
        continue;
      }
      if (event.kind === 'report' && toPatch && this.barOf.get(event.fromId) === event.toId) {
        this.#pour(toPatch, event.fromId, event, 'report', now);
        continue;
      }

      // Out of your kitchen to a table, and back again. A dispatch is a message whose text we
      // never saw — the session went from idle to working and nobody wrote down why — so it is
      // plated like any other order and served without a word.
      const mine = !event.fromId && event.toId && this.tableOf.has(event.toId);
      if (mine && (carries || event.kind === 'dispatch')) {
        this.#order(
          'send',
          event.toId,
          event.kind === 'dispatch' ? { ...event, text: null } : event,
          now,
        );
        continue;
      }
      if (event.kind === 'report' && !event.toId && this.tableOf.has(event.fromId)) {
        this.#order('report', event.fromId, event, now);
        continue;
      }

      if (carries && event.text && event.toId && this.placement.has(event.toId)) {
        this.#say(event.toId, event, now);
      }
    }
    if (this.toasts.length > 4) this.toasts.splice(0, this.toasts.length - 4);
    if (this.room.orders.length > 12) this.room.orders.splice(0, this.room.orders.length - 12);
  }

  /** Send a glass down the bar, carrying one message with it. */
  #pour(patch, workerId, event, kind, now) {
    const stoolTile = this.#stoolTileOf(workerId);
    if (!stoolTile) return;
    this.pours.push({
      from: kind === 'report' ? stoolTile.y : patch.tender.y,
      to: kind === 'report' ? patch.tender.y : stoolTile.y,
      kind,
      event,
      deliverTo: kind === 'report' ? patch.hubId : workerId,
      start: now,
      until: now + POUR_MS + POUR_HOLD,
    });
    if (kind !== 'report') {
      this.room.tenderPose.set(patch.hubId, { type: 'pour', until: now + POUR_MS });
    }
  }

  /**
   * Add one round trip to the kitchen's order book. The queue copy of a dish already ordered is
   * the same dish, so a message seen twice — once as a send, once from the session's own queue —
   * is not plated twice.
   */
  #order(kind, workerId, event, now) {
    const duplicate =
      this.room.orders.some((o) => o.kind === kind && o.workerId === workerId) ||
      this.room.waiters.some(
        (wt) =>
          wt.task?.kind === kind && wt.task.workerId === workerId && now - wt.task.since < 6000,
      );
    if (duplicate) return;
    this.room.orders.push({ kind, workerId, event, since: now });
  }

  /**
   * Hand the oldest order to a free waiter. An order is a round trip: to the pass for the dish,
   * out through the gate to the table, and back to the card table — or, for a report, out to the
   * table for the note and back to the kitchen with it.
   */
  #dispatchOrders(now) {
    const room = this.room;
    while (room.orders.length) {
      const waiter = room.waiters.find((wt) => !wt.task);
      if (!waiter) return;
      const order = room.orders.shift();
      const seat = this.#seatOf(order.workerId);
      if (!seat) continue;
      const { pickup, gate } = room.plan;
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
                  (room.chefPose = { type: 'handoff', until: this.#now() + HANDOFF_MS }),
              },
              { path: walk(pickup, serve), carry: 'send' },
              { pause: SERVE_PAUSE_MS, deliverTo: order.workerId },
              { path: walk(serve, waiter.seat) },
            ]
          : [
              { path: walk(waiter.seat, serve) },
              { pause: PICKUP_MS, deliverTo: order.workerId },
              { path: walk(serve, pickup), carry: 'report' },
              { pause: SERVE_PAUSE_MS },
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
   * Put a message over someone's head. Several arriving close together stack — a worker being
   * briefed in three parts should show three bubbles, not the last one — capped so a chatty
   * orchestrator cannot wallpaper the room.
   */
  #say(whoId, event, at) {
    if (!event.text) return;
    const stack = this.bubbles.get(whoId) ?? [];
    // The same line can reach a head twice — a send and its echo from the worker's own queue,
    // or a workspace the CLI briefly lost and found again. Say it once and let it linger.
    const last = stack[stack.length - 1];
    if (last && last.text === event.text && at - last.start < 4000) {
      last.until = at + BUBBLE_MS;
      return;
    }
    stack.push({ text: event.text, kind: event.kind, event, start: at, until: at + BUBBLE_MS });
    while (stack.length > BUBBLE_STACK) stack.shift();
    this.bubbles.set(whoId, stack);
    this.toasts.push({ event, start: at, until: at + TOAST_MS });
  }

  /** `PT-559 ← You` / `PT-559 → You`: who is talking to whom, by issue key. */
  #bubbleHeader(event, byId) {
    const tag = (id) => {
      if (!id) return 'You';
      const agent = byId.get(id);
      if (!agent) return 'someone';
      return issueOf(agent.name, agent.branch).key ?? agent.name.slice(0, 18);
    };
    return event.kind === 'report'
      ? `${tag(event.fromId)}  →  ${tag(event.toId)}`
      : `${tag(event.toId)}  ←  ${tag(event.fromId)}`;
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

    for (const pour of this.pours) {
      if (pour.said || t - pour.start < POUR_MS) continue;
      pour.said = true;
      this.#say(pour.deliverTo, pour.event, t);
    }
    this.pours = this.pours.filter((pour) => t < pour.until);

    if (!this.room) return;
    this.#dispatchOrders(t);
    for (const wt of this.room.waiters) {
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
   * either a path (walked one tile per STEP_MS) or a pause, at the start of which something may
   * happen (the chef hands over a dish) and at the end of which a message is delivered.
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

  /**
   * What the camera has to hold. Taken from the actual contents rather than from the grid's
   * corners: outside the frontage there is nothing to stand on and no ground under it, so the
   * grid is much wider than the picture and fitting to it would leave the world marooned in the
   * middle of the canvas.
   */
  #bounds(zone = null) {
    const dist = this.district;
    const plan = this.room.plan;
    const points = [];
    let centre = null;
    const at = (x, y, z = 0) => points.push(iso(x, y, z));
    if (zone === 'bar') {
      at(plan.ox, 0, WALL_H);
      at(plan.ox + FLOOR_X + 1, 0, WALL_H);
      at(plan.ox, plan.bar.y0 + plan.bar.len + 1);
      at(plan.ox + FLOOR_X + 1, plan.bar.y0 + plan.bar.len + 1);
    } else if (zone === 'tables') {
      at(plan.ox, FIRST_TABLE_Y - 2, 60);
      at(plan.ox + plan.w, FIRST_TABLE_Y - 2, 60);
      at(plan.ox, plan.lobbyY + 2);
      at(plan.ox + plan.w, plan.lobbyY + 2);
    } else if (zone === 'street') {
      const front = dist.street.roadY - 2;
      at(0, front, 70);
      at(dist.w, front, 70);
      at(0, dist.d);
      at(dist.w, dist.d);
    } else if (zone === 'room') {
      at(plan.ox, 0, WALL_H + 52);
      at(plan.ox + plan.w, 0, WALL_H + 52);
      at(plan.ox, plan.d + 2);
      at(plan.ox + plan.w, plan.d + 2);
    } else {
      // The default: the restaurant, centred, with the mountains showing over the city behind
      // it and the road and the river in front. The city runs to the edge of the canvas on
      // every side, so this is a framing rather than a fit — whatever does not fit is simply
      // more city.
      at(plan.ox - 3, 0, WALL_H + 52);
      at(plan.ox + plan.w + 3, 0, WALL_H + 52);
      at(plan.ox - 3, plan.d);
      at(plan.ox + plan.w + 3, plan.d);
      const roomXs = points.map((p) => p.x);
      const roomYs = points.map((p) => p.y);
      centre = {
        x: (Math.min(...roomXs) + Math.max(...roomXs)) / 2,
        y: (Math.min(...roomYs) + Math.max(...roomYs)) / 2,
      };
      points.push({ x: iso(plan.ox, plan.d).x, y: iso(plan.ox, 0).y - WALL_H - BACK_PEEK });
      points.push({
        x: iso(plan.ox + plan.w, plan.d).x,
        y: iso(plan.ox + plan.w, dist.d).y + FRONT_PEEK,
      });
    }
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return {
      minX: Math.min(...xs) - 26,
      maxX: Math.max(...xs) + 26,
      minY: Math.min(...ys) - 26,
      maxY: Math.max(...ys) + 32,
      centre,
    };
  }

  /** `1` the whole room, `2` the bar, `3` the tables, anything past that the street. */
  fitZone(index) {
    this.fit(false, ['room', 'bar', 'tables'][index] ?? 'street');
  }

  /**
   * The opening view: the restaurant centred, the blocks behind it and the road and quay in
   * front, at whatever zoom the canvas allows. It is also the edge of the world as far as the
   * camera is concerned — nothing outside it can be looked at.
   */
  #homeView() {
    const b = this.#bounds(null);
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const zoom = Math.max(
      ZOOM_FLOOR,
      Math.min(ZOOM_MAX, Math.min(cw / (b.maxX - b.minX), ch / (b.maxY - b.minY)) * 0.96),
    );
    // Framed on the restaurant, not on the box it shares with the road and the blocks: the
    // zoom comes from the whole, the centre from the room.
    return {
      zoom,
      x: b.centre.x - cw / zoom / 2,
      y: b.centre.y - (ch / zoom) * ROOM_CENTRE,
      w: cw / zoom,
      h: ch / zoom,
    };
  }

  /** Recompute the opening view and pull the camera back inside it. */
  #rehome() {
    this.home = this.#homeView();
    this.camera.zoom = this.#clampZoom(this.camera.zoom);
    this.#clampPan(this.camera);
    if (this.cameraTarget) {
      this.cameraTarget.zoom = this.#clampZoom(this.cameraTarget.zoom);
      this.#clampPan(this.cameraTarget);
    }
    if (this.zoomTarget !== null) this.zoomTarget = this.#clampZoom(this.zoomTarget);
  }

  #clampZoom(zoom) {
    return Math.min(ZOOM_MAX, Math.max(this.home?.zoom ?? ZOOM_FLOOR, zoom));
  }

  /** Keep a camera inside the opening view: at its zoom, that leaves exactly one position. */
  #clampPan(cam) {
    const home = this.home;
    if (!home) return cam;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    cam.x = Math.min(Math.max(cam.x, home.x), home.x + home.w - cw / cam.zoom);
    cam.y = Math.min(Math.max(cam.y, home.y), home.y + home.h - ch / cam.zoom);
    return cam;
  }

  /** The zoom at which the whole district — or one part of it — fits the canvas. */
  fit(immediate = false, zone = null) {
    if (!this.room) return;
    this.home = this.#homeView();
    let target;
    if (zone) {
      const b = this.#bounds(zone);
      const cw = this.canvas.clientWidth;
      const ch = this.canvas.clientHeight;
      const zoom = this.#clampZoom(Math.min(cw / (b.maxX - b.minX), ch / (b.maxY - b.minY)) * 0.96);
      target = this.#clampPan({
        zoom,
        x: (b.minX + b.maxX) / 2 - cw / zoom / 2,
        y: (b.minY + b.maxY) / 2 - ch / zoom / 2,
      });
    } else target = { zoom: this.home.zoom, x: this.home.x, y: this.home.y };
    this.zoomTarget = null;
    if (immediate) {
      this.camera = target;
      this.cameraTarget = null;
    } else this.cameraTarget = target;
  }

  #tileOfAgent(id) {
    const mover = this.movers.find((m) => m.role === 'diner' && m.id === id && m.pos);
    if (mover) return { x: Math.round(mover.pos.x), y: Math.round(mover.pos.y) };
    return this.placement.get(id)?.tile ?? null;
  }

  /** Glide the camera onto one person, or back out to the whole room. */
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
    zoom = this.#clampZoom(zoom);
    this.cameraTarget = this.#clampPan({
      zoom,
      x: at.x - this.canvas.clientWidth / zoom / 2,
      y: at.y - this.canvas.clientHeight / zoom / 2,
    });
  }

  /** Nudge the zoom by a factor about a screen point; the wheel, the keys and double-click all land here. */
  zoomBy(factor, anchor = null) {
    this.cameraTarget = null;
    const base = this.zoomTarget ?? this.camera.zoom;
    this.zoomTarget = this.#clampZoom(base * factor);
    this.zoomAnchor = anchor ?? { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 };
  }

  /**
   * Every frame the camera eases toward wherever it is headed. A wheel zoom eases the scale
   * while re-solving the pan so the world point under the cursor stays under the cursor — that,
   * more than the easing, is what makes zooming feel attached to the room.
   */
  #stepCamera() {
    if (this.zoomTarget !== null) {
      const anchor = this.zoomAnchor;
      const before = this.#toWorld(anchor.x, anchor.y);
      const next = this.camera.zoom + (this.zoomTarget - this.camera.zoom) * 0.22;
      this.camera.zoom = Math.abs(this.zoomTarget - next) < 0.002 ? this.zoomTarget : next;
      this.camera.x = before.x - anchor.x / this.camera.zoom;
      this.camera.y = before.y - anchor.y / this.camera.zoom;
      this.#clampPan(this.camera);
      if (this.camera.zoom === this.zoomTarget) this.zoomTarget = null;
      return;
    }
    const target = this.cameraTarget;
    if (!target) return;
    const k = 0.16;
    this.camera.zoom += (target.zoom - this.camera.zoom) * k;
    this.camera.x += (target.x - this.camera.x) * k;
    this.camera.y += (target.y - this.camera.y) * k;
    this.#clampPan(this.camera);
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
      this.hoverRoom = this.#overRoom(this.pointer.x, this.pointer.y);
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
      this.#clampPan(this.camera);
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
      this.hoverRoom = false;
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

  /** The room as the panel needs it: who is pouring for whom, and who is out on the floor. */
  roomState() {
    return {
      name: HOUSE_NAME,
      bar: (this.room?.patches ?? []).map((patch) => ({
        hubId: patch.hubId,
        members: patch.workers.slice(),
      })),
      tables: [...this.tableOf.keys()],
      queue: this.queue.slice(),
    };
  }

  /** What this session's own bartender has exchanged with it, if it has one. */
  connOf(id) {
    return this.#connOf(id);
  }

  select(id) {
    this.selectedId = id;
    this.focus(id);
    this.onSelect(id);
  }

  /** Whether a screen point is over the building, tested against its real silhouette. */
  #overRoom(sx, sy) {
    if (!this.room) return false;
    return inPolygon(this.#toWorld(sx, sy), this.room.silhouette);
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
    // The light for this frame; the tone map is on only while the world is being drawn, so
    // the chrome underneath keeps its own colours.
    this.light = lightAt(this.skyTime(), this.place, this.weather);
    this.lighting.set(this.light);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.lighting.shade('#0e1219');
    ctx.fillRect(0, 0, cw, ch);
    const k = this.camera.zoom;
    if (this.district) {
      // The part of the world under the glass, in world units: everything is drawn to it and
      // nothing past it.
      const view = {
        x0: this.camera.x,
        y0: this.camera.y,
        x1: this.camera.x + cw / k,
        y1: this.camera.y + ch / k,
        zoom: k,
      };
      ctx.setTransform(dpr * k, 0, 0, dpr * k, -this.camera.x * dpr * k, -this.camera.y * dpr * k);
      this.lighting.begin();
      this.#drawWorld(ctx, t, byId, view);
      drawCloudShadows(ctx, view, t, this.light, this.weather);
      this.lighting.end();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // What is falling is on the glass, not in the street: it does not scale with the zoom. It
    // does stop at the room, whose silhouette goes along in the same screen pixels.
    const shelter = this.room?.silhouette.map((p) => this.#toScreen(p.x, p.y)) ?? null;
    drawWeather(ctx, cw, ch, t, this.light, this.weather, shelter);
    this.#drawGlances(ctx, t);
    this.#drawLabels(ctx, byId);
    this.#drawBubbles(ctx, t, byId);
    this.#drawTooltip(ctx, byId);
    this.#drawToasts(ctx, byId, t);
  }

  /**
   * One pass over the whole district, back to front: the ground, the dining room, then the
   * street in front of it. Within the room and within the street everything is painter-sorted by
   * depth; between the two the order is fixed, because a building and a lamp post on the
   * pavement in front of it never need arguing about.
   */
  #drawWorld(b, t, byId, view) {
    const dist = this.district;
    drawCityGround(b, dist, view, t);
    drawGround(b, this.ground);
    // The city beside and behind the restaurant goes down before it: the back walls hide the
    // feet of what stands behind them, and nothing out there is ever in front of the room.
    for (const item of cityObjects(b, dist, view, t)) item.draw();
    this.#drawInside(b, t, byId);

    const street = [];
    const out = (x, y, layer, draw) => street.push({ depth: (x + y) * 10 + layer, draw });
    for (const prop of dist.props) out(prop.x, prop.y, 5, () => streetProp(b, prop, t));
    for (const prop of cityStreetProps(dist, view)) {
      out(prop.x, prop.y, 5, () => streetProp(b, prop, t));
    }
    for (const traffic of this.#traffic(t)) {
      out(traffic.x, traffic.y, 4, () =>
        car(b, traffic.x, traffic.y, traffic.index, traffic.dir, t, traffic.fade),
      );
    }
    street.sort((p, q) => p.depth - q.depth);
    for (const item of street) item.draw();
    drawQuay(b, dist, view, t);
  }

  /** Whether the kitchen has anything on: an order waiting, or a waiter out with one. */
  #kitchenBusy() {
    return this.room.orders.length > 0 || this.room.waiters.some((wt) => wt.task);
  }

  /** The restaurant, with everyone in it. */
  #drawInside(b, t, byId) {
    const room = this.room;
    const plan = room.plan;
    const { ox, w, d, gate, chef, lobbyY, entrance, podium, host, station, bar } = plan;

    walls(b, ox, w, d, WALL_H);
    // The left wall is the back bar for as far as the bar runs, and a dining-room wall below it.
    const barEnd = bar.y0 + bar.len - 1;
    for (let y = bar.y0 + 1; y < barEnd; y += 3) bottleShelf(b, ox, y, 46, y);
    for (let y = barEnd + 2; y < d - 3; y += 5) wallWindow(b, ox, 0, y, -1, 46, t);
    for (let y = barEnd + 4; y < d - 3; y += 5) wallLamp(b, ox, 0, y, -1, 30, t);
    // The back wall belongs to the kitchen, which is the only thing standing against it.
    for (let x = ox + FLOOR_X + 1; x + 3 < ox + w; x += 6) wallWindow(b, ox, x, 0, 1, 46, t);
    for (let x = ox + FLOOR_X; x + 2 < ox + w; x += 6) shelf(b, ox, x, 0, 1, 30);
    for (let x = ox + FLOOR_X + 4; x < ox + w - 1; x += 6) wallLamp(b, ox, x, 0, 1, 30, t);

    const items = [];
    const add = (x, y, layer, draw) => items.push({ depth: (x + y) * 10 + layer, draw });

    // ── the kitchen, in the back-right corner ───────────────────────────────────────────────
    for (let x = ox + FLOOR_X; x < ox + w; x++) {
      if (x !== gate) add(x, COUNTER_Y, 5, () => counter(b, x, COUNTER_Y));
    }
    add(gate, COUNTER_Y, 0, () => serviceBell(b, gate - 0.5, COUNTER_Y + 0.5, 18));
    add(chef.x - 1, chef.y, 3, () => stove(b, chef.x - 1, chef.y, this.#kitchenBusy(), t));
    add(chef.x, chef.y, 5, () => this.#drawChef(b, t));
    add(station.x, station.y, 5, () => cardTable(b, station.x, station.y, t));
    for (const wt of room.waiters) {
      const at = wt.task ? (wt.pos ?? wt.seat) : wt.seat;
      add(at.x, at.y, wt.task ? 6 : 4, () => this.#drawWaiter(b, wt, t));
    }

    // ── the bar: an L down the left wall and along the back ─────────────────────────────────
    // The boards go down first, then whoever is standing on them, then the counter in front.
    for (let y = bar.laneY; y <= barEnd; y++) add(bar.lane, y, 1, () => duckboard(b, bar.lane, y));
    for (let x = bar.lane + 1; x <= bar.armTo; x++) {
      add(x, bar.laneY, 1, () => duckboard(b, x, bar.laneY));
    }
    for (const patch of room.patches) {
      const hub = byId.get(patch.hubId);
      if (hub) add(patch.tender.x, patch.tender.y, 5, () => this.#drawBartender(b, patch, hub, t));
    }
    for (let y = bar.y0; y <= barEnd; y++) add(bar.x, y, 5, () => barCounter(b, bar.x, y));
    for (let x = bar.x + 1; x <= bar.armTo; x++) add(x, bar.y0, 5, () => barCounter(b, x, bar.y0));
    // Every tile of the counter has a stool at it, whether or not anybody is sitting there.
    for (const seat of bar.stools) add(seat.x, seat.y, 2, () => stool(b, seat.x, seat.y));
    for (const patch of room.patches) {
      add(bar.x, patch.tender.y, 6, () => barTaps(b, bar.x, patch.tender.y));
    }
    for (const pour of this.pours) {
      const k = Math.min(1, (t - pour.start) / POUR_MS);
      const y = pour.from + (pour.to - pour.from) * k;
      add(bar.x, y, 8, () => {
        const p = iso(bar.x + 0.5, y + 0.5, BAR_H);
        drink(b, p.x, p.y, pour.kind);
      });
    }

    // ── the rope line and the lobby ────────────────────────────────────────────────────────
    let prevPost = null;
    for (let x = ox; x <= ox + w; x++) {
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
    add(ox + w - 1, lobbyY + 1, 5, () => plant(b, ox + w - 1, lobbyY + 1));
    add(ox + FLOOR_X, KITCHEN_ROWS + 1, 5, () => plant(b, ox + FLOOR_X, KITCHEN_ROWS + 1));

    // ── everybody with a place in it ───────────────────────────────────────────────────────
    // The dining room is laid whether or not anybody is eating in it: an empty restaurant is a
    // quiet night, and a restaurant with no tables in it is a broken picture.
    const diningAt = new Map();
    for (const [id, place] of this.placement) {
      if (place.mode === 'seated') diningAt.set(this.tableOf.get(id), id);
    }
    plan.slots.forEach((slot, index) => {
      const seat = { tx: slot.tx, ty: slot.ty, cx: slot.tx, cy: slot.ty - 1 };
      const agent = byId.get(diningAt.get(index));
      add(seat.cx, seat.cy, 2, () => chair(b, seat.cx, seat.cy));
      if (agent) add(seat.cx, seat.cy, 5, () => this.#drawDiner(b, agent, seat, t));
      add(seat.tx, seat.ty, 5, () => this.#drawTable(b, agent, seat, t));
    });

    for (const [id, place] of this.placement) {
      const agent = byId.get(id);
      if (!agent) continue;
      if (place.mode === 'stool') {
        add(place.tile.x, place.tile.y, 5, () => this.#drawPatron(b, agent, place.tile, t));
      } else if (place.mode === 'queued') {
        add(place.tile.x, place.tile.y, 5, () => this.#drawQueued(b, agent, place.tile, t));
      }
    }
    for (const m of this.movers) {
      if (!m.pos) continue;
      add(m.pos.x, m.pos.y, 6, () => this.#drawWalker(b, m, byId));
    }

    items.sort((p, q) => p.depth - q.depth);
    for (const item of items) item.draw();
    restaurantTerrace(b, plan, t);
  }

  /**
   * Traffic. Nothing on the road is an agent — it is there so a street with nobody crossing it
   * still looks like a street — so it is generated from the clock and never from the fleet.
   */
  #traffic(t) {
    const { street, city, w } = this.district;
    const lanes = [
      { y: street.roadY + 0.05, dir: -1, gap: 0 },
      { y: street.roadY + 1.05, dir: 1, gap: 0.42 },
    ];
    const cars = [];
    const from = city.traffic.x0;
    const to = city.traffic.x1;
    // The same speed the cars always drove at, over a road that now runs a long way past the
    // district in both directions.
    const stretch = (to - from) / (w + 3);
    lanes.forEach((lane, index) => {
      const period = (CAR_PERIOD + index * 6500) * stretch;
      for (let n = 0; n < CARS_PER_LANE; n++) {
        const phase = (t / period + lane.gap + n / CARS_PER_LANE) % 1;
        const k = phase;
        const x = lane.dir > 0 ? from + k * (to - from) : to - k * (to - from);
        // A car arrives and leaves through a fade rather than blinking in at the end of the run.
        const fade = Math.max(0, Math.min(1, (x - from) / 3, (to - x) / 3));
        if (fade <= 0) continue;
        cars.push({ x, y: lane.y, index: index + n * 2, dir: lane.dir, fade });
      }
    });
    return cars;
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

  #person(b, agent, x, y, opts) {
    const look = lookFor(agent.id);
    const anchors = figure(b, x, y, dinerPalette(agent.id), { ...opts, style: look.style });
    this.anchorsOf ??= new Map();
    this.anchorsOf.set(agent.id, anchors);
    this.#hit(agent.id, anchors, 8);
    return anchors;
  }

  /** Somebody's arm up to be noticed: the one thing that gets an extra signal. */
  #raiseHand(b, agent, anchors, t) {
    const look = lookFor(agent.id);
    const raise = Math.round(Math.abs(Math.sin(t / 220)) * 2);
    b.fillStyle = look.body;
    b.fillRect(anchors.handX + 1, anchors.handY - 14 - raise, 3, 12);
    b.fillStyle = look.skin;
    b.fillRect(anchors.handX, anchors.handY - 18 - raise, 5, 5);
  }

  #drawDiner(b, agent, seat, t) {
    b.save();
    if (this.#emphasis(agent.id) < 1) b.globalAlpha = 0.6;
    if (agent.status === 'exited') b.globalAlpha *= 0.5;
    const anchors = this.#person(b, agent, seat.cx, seat.cy, { facing: 'front', z: 6 });
    seat.anchors = anchors;
    if (agent.status === 'waiting') this.#raiseHand(b, agent, anchors, t);
    b.restore();
  }

  #drawTable(b, agent, seat, t) {
    table(b, seat.tx, seat.ty, agent?.status ?? 'idle', t);
    if (!agent) return;
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

  /**
   * Somebody on a stool. They sit turned into the bar, elbows on it, which is the whole point:
   * at a glance the left wall is who is being orchestrated and the floor is who is not, without
   * reading a single label.
   */
  #drawPatron(b, agent, tile, t) {
    b.save();
    if (this.#emphasis(agent.id) < 1) b.globalAlpha = 0.6;
    if (agent.status === 'exited') b.globalAlpha *= 0.5;
    const anchors = this.#person(b, agent, tile.x, tile.y, { facing: 'back', flip: true, z: 11 });
    if (agent.status === 'working') {
      const lift = Math.round(Math.abs(Math.sin(t / 300)) * 3);
      drink(b, anchors.handX, anchors.handY - 2 - lift, 'send');
    }
    if (agent.status === 'waiting') {
      this.#raiseHand(b, agent, anchors, t);
      exclaim(b, anchors.headX + 11, anchors.headY - 6, t);
    }
    b.restore();
  }

  #drawQueued(b, agent, tile, t) {
    b.save();
    if (this.#emphasis(agent.id) < 1) b.globalAlpha = 0.6;
    if (agent.status === 'exited') b.globalAlpha *= 0.5;
    // Turned toward the rope: the line is people waiting to be shown in, not people watching you.
    const anchors = this.#person(b, agent, tile.x, tile.y, { facing: 'back' });
    if (agent.status === 'waiting') this.#raiseHand(b, agent, anchors, t);
    b.restore();
  }

  #drawWalker(b, m, byId) {
    const agent = byId.get(m.id);
    if (!agent) return;
    const { dx = 0, dy = 1 } = m.dir ?? {};
    const facing = dx > 0 || dy > 0 ? 'front' : 'back';
    const flip = dx < 0 || dy > 0;
    this.#person(b, agent, m.pos.x, m.pos.y, { facing, flip, step: m.step ?? 0 });
  }

  /**
   * The chef: you. Not a session, so it carries no name, no hitbox and no status — what it is
   * doing is whatever the kitchen is doing, which is however many messages of yours are on
   * their way out to the floor.
   */
  #drawChef(b, t) {
    const room = this.room;
    const { chef } = room.plan;
    const pal = chefPalette();
    const pose = room.chefPose && t < room.chefPose.until ? room.chefPose : null;
    const anchors = figure(b, chef.x, chef.y, pal, { facing: 'front', hat: 'chef' });
    room.chefAnchors = anchors;
    b.fillStyle = '#e8e8e2';
    b.fillRect(anchors.headX - 4, anchors.handY - 2, 9, 9); // apron
    b.fillStyle = '#1e1a1a';
    b.fillRect(anchors.headX - 4, anchors.handY - 2, 9, 1);
    if (pose?.type === 'handoff') {
      b.fillStyle = pal.b;
      b.fillRect(anchors.handX, anchors.handY - 6, 8, 3);
      tray(b, anchors.handX + 10, anchors.handY - 6, 'send');
    } else if (this.#kitchenBusy()) {
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

  /** A bartender behind its own patch: an orchestrator, mid-pour or polishing a glass. */
  #drawBartender(b, patch, hub, t) {
    const pal = bartenderPalette(hub.id);
    const anchors = figure(b, patch.tender.x, patch.tender.y, pal, {
      facing: 'front',
      z: DUCKBOARD_H,
    });
    this.anchorsOf ??= new Map();
    this.anchorsOf.set(hub.id, anchors);
    this.#hit(hub.id, anchors, 12);
    b.fillStyle = '#f6f6f2';
    b.fillRect(anchors.headX - 2, anchors.headY + 11, 4, 6); // shirt front
    b.fillStyle = '#c9a227';
    b.fillRect(anchors.headX - 2, anchors.headY + 12, 4, 2); // bow tie
    const pose = patch.hubId && this.room.tenderPose.get(patch.hubId);
    if (pose && t < pose.until) {
      drink(b, anchors.handX + 2, anchors.handY - 4, 'send');
    } else if (hub.status === 'working') {
      // Polishing a glass, which is what a bartender does while it is thinking.
      const wipe = Math.round(Math.sin(t / 240) * 2);
      drink(b, anchors.handX + 1, anchors.handY - 3, 'report');
      b.fillStyle = '#e8e8e2';
      b.fillRect(anchors.handX + 3 + wipe, anchors.handY - 12, 3, 4);
    }
  }

  #drawHost(b, t) {
    const { host } = this.room.plan;
    const pal = hostPalette();
    const anchors = figure(b, host.x, host.y, pal, { facing: 'front' });
    b.fillStyle = '#1e1a1a';
    b.fillRect(anchors.headX - 2, anchors.headY + 12, 4, 2); // bow tie
    const waving = this.room.hostPose && t < this.room.hostPose.until;
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
    const a = this.anchorsOf?.get(id);
    return a ? this.#toScreen(a.headX, a.headY) : null;
  }

  #drawGlances(ctx, t) {
    this.glances = this.glances.filter((g) => t < g.until);
    for (const glance of this.glances) {
      const to = this.#headScreen(glance.workerId);
      const from = this.#headScreen(glance.hubId);
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
    // Several people at the bar stand a tile apart, which in the isometry is eight pixels of
    // stagger and nothing like enough for their labels. Anything that would land on top of one
    // already placed is pushed up until it does not.
    const placed = [];
    const clear = (x, y, w, h) =>
      !placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y);
    const draw = (agent, at, isHub, conn, tight) => {
      const status = STATUS[agent.status] ?? STATUS.idle;
      const full = focus === agent.id;
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
      let y = at.y - height;
      for (let i = 0; i < 8 && !clear(x, y, width, height + 5); i++) y -= height + 5;
      placed.push({ x, y, w: width, h: height + 5 });
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
        const tag = 'BARTENDER';
        const tw = ctx.measureText(tag).width + 14;
        roundRect(ctx, at.x - tw / 2, y - 11, tw, 16, 8);
        ctx.fillStyle = '#c792ea';
        ctx.fill();
        ctx.fillStyle = '#1a1226';
        ctx.fillText(tag, at.x, y - 3);
      }
      ctx.restore();
    };

    // The house title and the chef go down first, so every name that follows knows to dodge them.
    this.#drawHouseSign(ctx, byId, placed);
    this.#drawChefTag(ctx, placed);

    const k = this.camera.zoom;
    for (const [id, place] of this.placement) {
      const agent = byId.get(id);
      const head = this.#headScreen(id);
      if (!agent || !head) continue;
      const isHub = Boolean(this.#patchOfHub(id));
      const dense = place.mode === 'queued' || place.mode === 'stool';
      if (dense && !zoomedIn && focus !== id && !isHub) continue;
      draw(
        agent,
        // A bartender's label is lifted clear of the bar: it stands with its back to the pass
        // and a label at the usual height would sit on the one figure it is naming.
        { x: head.x, y: head.y - 14 * k - (isHub ? 26 : 4) },
        isHub,
        isHub ? null : this.#connOf(id),
        !zoomedIn,
      );
    }
  }

  /** A small permanent tag over the kitchen, because the chef has no name to hover for. */
  #drawChefTag(ctx, placed) {
    const anchors = this.room.chefAnchors;
    if (!anchors) return;
    const head = this.#toScreen(anchors.headX, anchors.headY);
    const y = head.y - 14 * this.camera.zoom - 12;
    ctx.save();
    ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tag = 'YOU · CHEF';
    const w = ctx.measureText(tag).width + 14;
    roundRect(ctx, head.x - w / 2, y - 8, w, 16, 8);
    ctx.fillStyle = '#ffd166';
    ctx.fill();
    ctx.fillStyle = '#2a1f05';
    ctx.fillText(tag, head.x, y);
    ctx.restore();
    placed?.push({ x: head.x - w / 2, y: y - 8, w, h: 21 });
  }

  /**
   * The name over the restaurant, hung above its back wall where there is nothing to collide
   * with, and under it the state of the whole fleet in one line: how many are at the bar being
   * orchestrated, how many are at the tables waiting on you, and whether any of them is stuck.
   */
  #drawHouseSign(ctx, byId, placed) {
    const plan = this.room.plan;
    const ridge = iso(plan.ox + plan.w / 2, 0, WALL_H + 30);
    const at = this.#toScreen(ridge.x, ridge.y);
    if (at.x < -180 || at.x > this.canvas.clientWidth + 180) return;
    const count = (mode) => [...this.placement.values()].filter((p) => p.mode === mode).length;
    const waiting = [...this.placement.keys()].filter(
      (id) => byId.get(id)?.status === 'waiting',
    ).length;
    const sub = `${count('stool')} at the bar · ${count('seated')} dining · ${count('queued')} in line${
      waiting ? ` · ${waiting} waiting on you` : ''
    }`;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    const nameW = ctx.measureText(plan.name).width;
    ctx.font = '500 10.5px ui-monospace, SFMono-Regular, monospace';
    const subW = ctx.measureText(sub).width;
    const width = Math.max(nameW, subW) + 26;
    const height = 38;
    const x = at.x - width / 2;
    const y = at.y - height - 8;
    ctx.fillStyle = 'rgba(13,18,26,0.92)';
    ctx.strokeStyle = this.hoverRoom ? '#ffd166' : 'rgba(199,146,234,0.7)';
    ctx.lineWidth = this.hoverRoom ? 1.6 : 1;
    roundRect(ctx, x, y, width, height, 8);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(at.x - 4, y + height);
    ctx.lineTo(at.x, y + height + 5);
    ctx.lineTo(at.x + 4, y + height);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eef3f9';
    ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(plan.name, at.x, y + 13);
    ctx.fillStyle = waiting ? '#ffbf47' : '#8b9cb3';
    ctx.font = '500 10.5px ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(sub, at.x, y + 27);
    ctx.restore();
    placed?.push({ x, y, w: width, h: height + 5 });
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

  /**
   * The tooltip: three things and nothing else. Who it is, what it is doing this minute, and
   * what the task is. Where it is sitting, which model, the token count and the last thing it
   * said are all one click away in the thread, and on a hover they were noise in front of
   * the two lines a person actually stops to read.
   */
  #drawTooltip(ctx, byId) {
    const id = this.hoverId;
    if (!id || id === this.selectedId) return;
    const agent = byId.get(id);
    if (!agent) return;
    const status = STATUS[agent.status] ?? STATUS.idle;
    ctx.save();
    const wrap = (text, font, color, max) => {
      ctx.font = font;
      return wrapText(ctx, text, 236, max).map((line) => ({ text: line, font, color }));
    };
    const doing = agent.doing;
    const working = agent.status === 'working' && doing;
    const dur = agent.status === 'working' ? plainActivity(agent.activity ?? '') : '';
    const state = `${status.sub}${dur ? ` · ${dur}` : ''}`;
    const now =
      working && doing.phase !== 'thinking'
        ? `${doing.label}${doing.detail ? ` · ${doing.detail}` : ''}`
        : working
          ? 'thinking'
          : null;
    const color = working ? (PHASE_COLOR[doing.phase] ?? PHASE_COLOR.thinking) : status.color;
    const title = taskTitle(agent);
    const mono = '600 10.5px ui-monospace, SFMono-Regular, monospace';
    const rows = [
      ...wrap(agent.name, '600 13px ui-sans-serif, system-ui, sans-serif', '#eef3f9', 2),
      ...wrap(state, mono, status.color, 1),
      ...(now ? wrap(`▸ ${now}`, mono, color, 2) : []),
      ...(title
        ? wrap(title, '500 11.5px ui-sans-serif, system-ui, sans-serif', '#c9d4e2', 3)
        : []),
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
      const from = event.fromId ? (byId.get(event.fromId)?.name ?? 'someone') : 'You';
      const to = event.toId ? (byId.get(event.toId)?.name ?? 'someone') : 'the kitchen';
      const header =
        event.kind === 'report'
          ? `${short(from)}  sent word back`
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

/** Ray-casting point-in-polygon, for hit-testing the building's silhouette. */
function inPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y) {
      if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

function short(name) {
  return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}
