// The district: two restaurants, and the street they stand on.
//
// A restaurant is one orchestration and nothing else — a chef, and the sessions that chef is
// driving. The Orchestra belongs to the elected orchestrator; The Architects, next door, to a
// second session seen driving peers of its own. Everyone nobody is supervising is outside on
// the pavement eating from the food carts, and the moment an orchestrator first messages one
// of them, that session puts its food down, crosses the road and comes in.
//
// The rooms are cutaways: no roof, no front wall, the whole dining room in view. Nothing else
// stands on the block — in this projection anything to the right of a room is in FRONT of it
// and rises over the floor, and a building that hides half a dining room earns its place in
// nothing. The two rooms sit five tiles apart, which is the closest the right-hand one's wall
// can stand without climbing into its neighbour's floor.
//
// Everything is drawn straight onto the retina canvas at the current zoom, so it is crisp at
// any scale and zooming is continuous. Everything with a position lives on one tile grid;
// anyone who moves walks it tile by tile along a BFS path, indoors and out.

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
import { buildDistrict, COUNTER_Y, ENTRANCE_X, MAX_CARTS, HOUSE_WALL_H } from './district.js';
import {
  skyGlow,
  buildGround,
  drawGround,
  restaurantTerrace,
  houseSilhouette,
  foodCart,
  streetProp,
  streetFood,
  backRailing,
  car,
} from './street.js';

const WALL_H = HOUSE_WALL_H;
const ZOOM_MIN = 0.32; // screen pixels per world unit
const ZOOM_MAX = 6;

/** Sessions with no Superset project of their own share one cart. */
const NO_PROJECT = 'no-project';
const CAR_PERIOD = 21_000;

/** A session must be seen driving this many peers of its own to be a second orchestrator. */
const SECOND_HUB_MIN = 2;

/** The two houses on the block, in the order they stand along the street, left to right. */
const HOUSES = [
  { key: 'architects', name: 'The Architects' },
  { key: 'orchestra', name: 'The Orchestra' },
];

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
    this.homeOf = new Map();
    this.shapeSignature = '';
    this.district = null;
    this.ground = null;
    /** One per restaurant: its plan, its chef, its tables, its waiters and its own queue. */
    this.houses = [];
    this.carts = [];
    this.cartKeys = '';
    /** workspaceId → which house it is a guest of, and which of that house's tables it has */
    this.tableOf = new Map();
    /** workspaceId → index of the cart it eats at, and its standing place in that cart's line */
    this.cartOf = new Map();
    this.streetSpot = new Map();
    /** workspaceId → which of a cart's three places at the hatch it has, while it is working */
    this.eatOf = new Map();
    this.placement = new Map();
    this.blocked = new Set();
    this.blockedStaff = new Set();
    this.movers = [];
    this.hitboxes = [];
    this.glances = [];
    this.bubbles = new Map();
    this.toasts = [];
    this.selectedId = null;
    this.hoverId = null;
    /** The house the pointer is over, and the one a click has pinned open. */
    this.hoverHouse = null;
    this.pinnedHouse = null;
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
    this.#layout();
    if (this.needsFit && this.agents.length) {
      this.fit(true);
      this.needsFit = false;
    }
  }

  /**
   * Who is chef where.
   *
   * The server elects ONE orchestrator: whoever has been seen driving the most peers. A second
   * is found here from the same tally — any other live session driving two or more peers of its
   * own that the first is not already driving. Such a session is nobody's worker, so it gets the
   * house next door rather than a table in this one.
   */
  #electHubs() {
    const alive = new Set(this.agents.map((a) => a.id));
    const orchestra = this.hubId && alive.has(this.hubId) ? this.hubId : null;
    const driven = new Set(this.links.filter((l) => l.fromId === orchestra).map((l) => l.toId));
    const fan = new Map();
    for (const link of this.links) {
      if (link.fromId === link.toId) continue;
      if (!alive.has(link.fromId) || !alive.has(link.toId)) continue;
      if (!fan.has(link.fromId)) fan.set(link.fromId, new Set());
      fan.get(link.fromId).add(link.toId);
    }
    let architects = null;
    let best = SECOND_HUB_MIN - 1;
    for (const [id, peers] of fan) {
      // A session the first orchestrator drives is its worker, whatever else it gets up to.
      if (id === orchestra || driven.has(id)) continue;
      const score = [...peers].filter((p) => p !== orchestra && !driven.has(p)).length;
      if (score > best) {
        best = score;
        architects = id;
      }
    }
    return { orchestra, architects };
  }

  /**
   * One record per worker of `hubId`, both directions folded together. A worker is a session
   * the chef has DRIVEN — a link outbound from it. The reverse direction alone does not
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

  /** The house a session is a guest of, or null if it is out on the street. */
  #homeOf(id) {
    const key = this.homeOf.get(id);
    return key ? (this.houses.find((h) => h.key === key) ?? null) : null;
  }

  /** The house whose chef this session is, if it is one. */
  #houseOfHub(id) {
    return this.houses.find((h) => h.hubId && h.hubId === id) ?? null;
  }

  /** What the chef of this session's house has exchanged with it. */
  #connOf(id) {
    for (const house of this.houses) {
      const conn = house.conns.get(id);
      if (conn) return conn;
    }
    return null;
  }

  /**
   * Build the whole district: two restaurants, each big enough for its own orchestration, and
   * a street with one food cart per project that has sessions nobody is supervising.
   */
  #buildDistrict(seatsByKey, cartPlan) {
    const plan = buildDistrict({
      houses: HOUSES.map((house) => ({ ...house, seats: seatsByKey.get(house.key) ?? 4 })),
      carts: cartPlan,
    });
    this.district = plan;
    this.ground = buildGround(plan);
    this.carts = plan.carts;
    this.blocked = plan.blocked;
    this.blockedStaff = plan.blockedStaff;
    this.cartKeys = cartKeyList(cartPlan);
    this.houses = plan.houses.map((housePlan) => ({
      key: housePlan.key,
      plan: housePlan,
      hubId: null,
      conns: new Map(),
      queue: [],
      orders: [],
      chefPose: null,
      hostPose: null,
      silhouette: houseSilhouette(housePlan),
      waiters: housePlan.waiterSeats.slice(0, WAITERS).map((seat, index) => ({
        index,
        seat,
        pal: waiterPalette(index),
        task: null,
        pos: null,
      })),
    }));
    this.homeOf = new Map();
    this.tableOf = new Map();
    this.cartOf = new Map();
    this.streetSpot = new Map();
    this.eatOf = new Map();
    this.placement = new Map();
    this.movers = [];
  }

  /** Where the n-th person in a house's line stands, wrapping to a second row if it fills up. */
  #queueTile(house, index) {
    const { ox, w, lobbyY } = house.plan;
    const perRow = Math.max(1, Math.floor((w - ENTRANCE_X - 1) / 2));
    return {
      x: ox + ENTRANCE_X + 2 * (index % perRow),
      y: lobbyY + 2 + Math.floor(index / perRow),
    };
  }

  #seatOf(id) {
    const house = this.#homeOf(id);
    const slot = house?.plan.slots[this.tableOf.get(id)];
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
   * The vans that should be on the kerb. A project keeps its van for as long as the district
   * stands, even once every one of its sessions has been taken indoors — a van vanishing the
   * moment its last customer is served would rebuild the world at exactly the wrong moment.
   */
  #cartPlan(outsiders) {
    const wanted = planCarts(outsiders);
    const plan = this.carts
      .filter((cart) => !cart.closed)
      .map(({ key, label }) => ({ key, label }));
    for (const cart of wanted) {
      if (plan.some((p) => p.key === cart.key)) continue;
      if (plan.length >= MAX_CARTS) {
        // No kerb left: the van nobody is queueing at makes way for the one they are.
        const idle = plan.findIndex((p) => !wanted.some((c) => c.key === p.key));
        if (idle === -1) break;
        plan.splice(idle, 1);
      }
      plan.push(cart);
    }
    return plan;
  }

  /** Which house has its roof off: the one pinned by a click, else the one under the pointer. */
  #openKey() {
    return this.pinnedHouse ?? this.hoverHouse;
  }

  #cartOfAgent(id) {
    const index = this.cartOf.get(id);
    return index === undefined ? null : (this.carts[index] ?? null);
  }

  /**
   * A place at a cart's hatch, held for as long as the session is working. Three people can
   * eat at a van at once; a fourth stays in the line until one of them is done.
   */
  #claimHatch(id, cart) {
    if (this.eatOf.has(id)) return cart.eat[this.eatOf.get(id)];
    const taken = new Set();
    for (const [other, slot] of this.eatOf) {
      if (this.cartOf.get(other) === cart.index) taken.add(slot);
    }
    for (let i = 0; i < cart.eat.length; i++) {
      if (taken.has(i)) continue;
      this.eatOf.set(id, i);
      return cart.eat[i];
    }
    return null;
  }

  /** Where a session on the street belongs right now: at the hatch if working, in line if not. */
  #streetTarget(agent) {
    const cart = this.#cartOfAgent(agent.id);
    if (!cart) return null;
    const busy = agent.status === 'working' || agent.status === 'waiting';
    if (busy) {
      const hatch = this.#claimHatch(agent.id, cart);
      if (hatch) return { mode: 'eating', tile: hatch };
    } else {
      this.eatOf.delete(agent.id);
    }
    const spot = this.streetSpot.get(agent.id) ?? 0;
    return { mode: 'lining', tile: cart.queue[spot % cart.queue.length] };
  }

  /**
   * How big each house wants to be. Quantised in steps, because rebuilding re-seats everyone
   * where they stand and throws away whatever walk was in progress — including the one walk
   * that matters most, a session crossing the road because it has just been picked up. Sizing
   * to every single arrival would rebuild the world at exactly the wrong moment.
   */
  #shapeOf(counts) {
    const seats = new Map(
      HOUSES.map((house) => [
        house.key,
        Math.max(6, Math.ceil(((counts.get(house.key) ?? 0) + 2) / 4) * 4),
      ]),
    );
    // The two houses front the same pavement, so they share a depth; the signature has to say
    // so, or a rebuild would be decided against a shape the builder would not produce.
    const shapes = HOUSES.map((house) => {
      const party = Math.max(1, seats.get(house.key));
      const cols = Math.max(2, Math.ceil(Math.sqrt(party * 1.4)));
      return { cols, rows: Math.max(1, Math.ceil(party / cols)) };
    });
    const rows = Math.max(...shapes.map((shape) => shape.rows));
    return { seats, signature: `${shapes.map((s) => s.cols).join('x')}@${rows}` };
  }

  /**
   * Seating, the queues, and the pavement.
   *
   * A restaurant is for one orchestration and nothing else: its chef, and the sessions that
   * chef has actually been observed driving. Everyone else is a session running on its own and
   * belongs outside at a cart. A table, once given, is kept for the whole run; so is a place at
   * a cart, so the street does not reshuffle every time somebody finishes a turn.
   */
  #layout() {
    const hubs = this.#electHubs();
    const chefs = new Set(Object.values(hubs).filter(Boolean));
    const connsByKey = new Map();
    const claimed = new Set(chefs);
    for (const house of HOUSES.slice().reverse()) {
      // The Orchestra picks its workers first: a session both chefs have driven is the elected
      // orchestrator's, and only what is left over can fill the house next door.
      const conns = this.#connsFor(hubs[house.key], claimed);
      for (const id of conns.keys()) claimed.add(id);
      connsByKey.set(house.key, conns);
    }

    const guests = this.agents.filter((a) => !chefs.has(a.id));
    const counts = new Map(
      HOUSES.map((house) => [
        house.key,
        guests.filter((a) => connsByKey.get(house.key).has(a.id)).length,
      ]),
    );
    const outsiders = guests.filter((a) => !claimed.has(a.id));
    const cartPlan = this.#cartPlan(outsiders);
    const shape = this.#shapeOf(counts);

    if (
      !this.district ||
      shape.signature !== this.shapeSignature ||
      cartKeyList(cartPlan) !== this.cartKeys
    ) {
      this.#buildDistrict(shape.seats, cartPlan);
      this.shapeSignature = shape.signature;
    }
    const fresh = this.placement.size === 0;
    for (const house of this.houses) {
      house.hubId = hubs[house.key] ?? null;
      house.conns = connsByKey.get(house.key) ?? new Map();
    }

    const alive = new Set(guests.map((a) => a.id));
    for (const id of [...this.placement.keys()]) {
      if (alive.has(id)) continue;
      this.#forget(id);
    }

    // A session that has just been picked up gives up its cart; one that is no longer driven,
    // or that has changed chef, gives up its table. Both then walk to the other place.
    for (const agent of guests) {
      const wants = HOUSES.find((house) => connsByKey.get(house.key).has(agent.id))?.key ?? null;
      const has = this.homeOf.get(agent.id) ?? null;
      if (wants === has) continue;
      if (has) {
        const house = this.#homeOf(agent.id);
        if (house) house.queue = house.queue.filter((q) => q !== agent.id);
        this.homeOf.delete(agent.id);
        this.tableOf.delete(agent.id);
      }
      if (wants) {
        this.cartOf.delete(agent.id);
        this.streetSpot.delete(agent.id);
        this.eatOf.delete(agent.id);
        this.homeOf.set(agent.id, wants);
      }
    }

    for (const house of this.houses) {
      const taken = new Set();
      for (const [id, slot] of this.tableOf) {
        if (this.homeOf.get(id) === house.key) taken.add(slot);
      }
      const unseated = guests
        .filter((a) => this.homeOf.get(a.id) === house.key && !this.tableOf.has(a.id))
        .sort((a, b) => {
          const ca = house.conns.get(a.id);
          const cb = house.conns.get(b.id);
          if (Boolean(ca) !== Boolean(cb)) return ca ? -1 : 1;
          if (ca && cb) return (cb.lastAt || 0) - (ca.lastAt || 0);
          return a.name.localeCompare(b.name);
        });
      for (const agent of unseated) {
        const slot = house.plan.slots.findIndex((_, i) => !taken.has(i));
        if (slot === -1) break;
        this.tableOf.set(agent.id, slot);
        taken.add(slot);
      }
    }

    const byCart = new Map(this.carts.map((cart) => [cart.key, cart]));
    for (const agent of outsiders) {
      if (this.cartOf.has(agent.id)) continue;
      const cart =
        byCart.get(cartKeyOf(agent)) ?? this.carts.find((c) => !c.closed) ?? this.carts[0];
      if (!cart) continue;
      const used = new Set();
      for (const [other, index] of this.streetSpot) {
        if (this.cartOf.get(other) === cart.index) used.add(index);
      }
      let spot = 0;
      while (used.has(spot)) spot += 1;
      this.cartOf.set(agent.id, cart.index);
      this.streetSpot.set(agent.id, spot);
    }

    for (const agent of guests) {
      const house = this.#homeOf(agent.id);
      if (house) this.#seatIndoors(agent, house, fresh);
      else this.#standOutside(agent);
    }

    // Everyone still in a line shuffles up to fill the gap left by whoever was seated.
    for (const house of this.houses) {
      house.queue.forEach((id, index) => {
        const cur = this.placement.get(id);
        const target = this.#queueTile(house, index);
        if (!cur || cur.mode !== 'queued') return;
        if (cur.tile.x === target.x && cur.tile.y === target.y) return;
        const agent = this.agents.find((a) => a.id === id);
        if (agent) this.#walk(agent, cur.tile, target, 'queued');
      });
    }
  }

  #forget(id) {
    const house = this.#homeOf(id);
    if (house) house.queue = house.queue.filter((q) => q !== id);
    this.homeOf.delete(id);
    this.tableOf.delete(id);
    this.cartOf.delete(id);
    this.streetSpot.delete(id);
    this.eatOf.delete(id);
    this.placement.delete(id);
    this.movers = this.movers.filter((m) => m.id !== id);
  }

  #seatIndoors(agent, house, fresh) {
    const seat = this.#seatOf(agent.id);
    if (!seat) return;
    const wants = agent.status === 'idle' || agent.status === 'exited' ? 'queued' : 'seated';
    const cur = this.placement.get(agent.id);
    if (!cur) {
      // First sight: no walking, just put everyone where they are.
      if (wants === 'queued') {
        house.queue.push(agent.id);
        this.placement.set(agent.id, {
          mode: 'queued',
          tile: this.#queueTile(house, house.queue.length - 1),
        });
      } else {
        this.placement.set(agent.id, { mode: 'seated', tile: { x: seat.cx, y: seat.cy } });
      }
      return;
    }
    if (cur.mode === 'walking' || cur.mode === wants) return;
    if (wants === 'seated') {
      house.queue = house.queue.filter((q) => q !== agent.id);
      this.#walk(agent, cur.tile, { x: seat.cx, y: seat.cy }, 'seated');
    } else {
      // The latest arrival takes the front of the line, at the podium, and is greeted.
      house.queue.unshift(agent.id);
      this.#walk(agent, cur.tile, this.#queueTile(house, 0), 'queued');
      if (!fresh) house.hostPose = { type: 'wave', until: this.#now() + GREET_MS };
    }
  }

  #standOutside(agent) {
    const target = this.#streetTarget(agent);
    if (!target) return;
    const cur = this.placement.get(agent.id);
    if (!cur) {
      this.placement.set(agent.id, { mode: target.mode, tile: target.tile });
      return;
    }
    if (cur.mode === 'walking') return;
    if (cur.mode === target.mode && cur.tile.x === target.tile.x && cur.tile.y === target.tile.y) {
      return;
    }
    this.#walk(agent, cur.tile, target.tile, target.mode);
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
   * Shortest walk between two tiles, avoiding furniture, the kitchen, the buildings and the
   * road — the road except at the crossing, which is what sends anyone walking in from the
   * street over the zebra and in at the door.
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

  addEvents(events) {
    const now = this.#now();
    if (!this.district) return;
    for (const event of events) {
      // An event belongs to whichever house's chef is at one end of it.
      const fromHouse = event.fromId ? this.#houseOfHub(event.fromId) : null;
      const toHouse = event.toId ? this.#houseOfHub(event.toId) : null;
      const house = fromHouse ?? toHouse;
      const worker = fromHouse ? event.toId : toHouse ? event.fromId : null;
      const seat = worker && this.#homeOf(worker) === house ? this.#seatOf(worker) : null;
      // Only actual traffic gets a speech bubble. A spawn and a gone carry the workspace's
      // NAME as their text, and putting that over a head reads as the session saying its own
      // name — on a machine where workspaces come and go, a wall of them.
      const readable =
        Boolean(event.text) &&
        (event.kind === 'send' || event.kind === 'inbox' || event.kind === 'report');

      if (event.kind === 'read' && fromHouse && seat) {
        if (this.showReads)
          this.glances.push({
            hubId: house.hubId,
            workerId: worker,
            start: now,
            until: now + GLANCE_MS,
          });
        continue;
      }

      if ((event.kind === 'send' || event.kind === 'inbox') && fromHouse && seat) {
        // The queue copy of a dish already ordered is the same dish; do not plate it twice.
        const duplicate =
          house.orders.some((o) => o.kind === 'send' && o.workerId === worker) ||
          house.waiters.some(
            (wt) =>
              wt.task?.kind === 'send' && wt.task.workerId === worker && now - wt.task.since < 6000,
          );
        if (!duplicate) house.orders.push({ kind: 'send', workerId: worker, event, since: now });
        continue;
      }

      if (event.kind === 'report' && toHouse && seat) {
        house.orders.push({ kind: 'report', workerId: worker, event, since: now });
        continue;
      }

      if (
        readable &&
        event.toId &&
        (this.placement.has(event.toId) || this.#houseOfHub(event.toId))
      ) {
        this.#say(event.toId, event, now);
      }
    }
    if (this.toasts.length > 4) this.toasts.splice(0, this.toasts.length - 4);
    for (const house of this.houses) {
      if (house.orders.length > 12) house.orders.splice(0, house.orders.length - 12);
    }
  }

  /**
   * Hand the oldest order to a free waiter. An order is a round trip: to the chef for the
   * dish, out through the gate to the table, and back to the card table — or, for a report,
   * out to the table for the note and back to the chef with it.
   */
  #dispatch(house, now) {
    while (house.orders.length) {
      const waiter = house.waiters.find((wt) => !wt.task);
      if (!waiter) return;
      const order = house.orders.shift();
      const seat = this.#seatOf(order.workerId);
      if (!seat) continue;
      const { pickup, gate } = house.plan;
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
                  (house.chefPose = { type: 'handoff', until: this.#now() + HANDOFF_MS }),
              },
              { path: walk(pickup, serve), carry: 'send' },
              { pause: SERVE_PAUSE_MS, deliverTo: order.workerId },
              { path: walk(serve, waiter.seat) },
            ]
          : [
              { path: walk(waiter.seat, serve) },
              { pause: PICKUP_MS },
              { path: walk(serve, pickup), carry: 'report' },
              { pause: SERVE_PAUSE_MS, deliverTo: house.hubId },
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

  /** `PT-559 ← Orchestra` / `PT-559 → Orchestra`: who is talking to whom, by issue key. */
  #bubbleHeader(event, byId) {
    const from = byId.get(event.fromId);
    const to = byId.get(event.toId);
    const tag = (agent) => {
      if (!agent) return 'someone';
      const house = this.#houseOfHub(agent.id);
      if (house) return house.plan.name.replace(/^The\s+/i, '');
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

    for (const house of this.houses) {
      this.#dispatch(house, t);
      for (const wt of house.waiters) {
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

  /**
   * What the camera has to hold. Taken from the actual contents rather than from the grid's
   * corners: the block next door is a row of solids standing in the dark with no ground under
   * it, so the grid is much bigger than the picture and fitting to it would leave the world
   * marooned in the middle of the canvas.
   */
  #bounds(zone = null) {
    const dist = this.district;
    const points = [];
    const at = (x, y, z = 0) => points.push(iso(x, y, z));
    const house = this.houses.find((h) => h.key === zone);
    if (house) {
      const plan = house.plan;
      at(plan.ox, 0, WALL_H + 52);
      at(plan.ox + plan.w, 0, WALL_H + 52);
      at(plan.ox, plan.d + 2);
      at(plan.ox + plan.w, plan.d + 2);
    } else if (zone === 'street') {
      const front = dist.street.roadY - 2;
      at(0, front, 70);
      at(dist.w, front, 70);
      at(0, dist.d);
      at(dist.w, dist.d);
    } else {
      for (const plan of dist.houses) {
        at(plan.ox, 0, WALL_H + 52);
        at(plan.ox + plan.w, 0, WALL_H + 52);
        at(plan.ox, plan.d);
        at(plan.ox + plan.w, plan.d);
      }
      at(0, dist.houseDepth - 1);
      at(dist.w, dist.houseDepth - 1);
      at(0, dist.d);
      at(dist.w, dist.d);
    }
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    return {
      minX: Math.min(...xs) - 26,
      maxX: Math.max(...xs) + 26,
      minY: Math.min(...ys) - 26,
      maxY: Math.max(...ys) + 32,
    };
  }

  /** The zoom at which the whole district — or one half of it — fits the canvas. */
  fit(immediate = false, zone = null) {
    const b = this.#bounds(zone);
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
    const house = this.#houseOfHub(id);
    if (house) return house.plan.chef;
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
      const over = this.#houseAt(this.pointer.x, this.pointer.y);
      const owner = this.hoverId
        ? (this.#homeOf(this.hoverId) ?? this.#houseOfHub(this.hoverId))
        : null;
      this.hoverHouse = over ?? owner?.key ?? null;
      this.canvas.style.cursor = dragging
        ? 'grabbing'
        : this.hoverId || this.hoverHouse
          ? 'pointer'
          : 'grab';
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
      this.hoverHouse = null;
    });
    this.canvas.addEventListener('click', (e) => {
      if (moved >= 5) return;
      const at = local(e);
      const id = this.#agentAt(at.x, at.y);
      // Clicking the floor is not a way out: only Esc deselects, so a near-miss on a figure
      // cannot throw the camera back to the whole block.
      if (id) {
        this.select(id);
        return;
      }
      // Clicking a house pins its roof off, so you can look around inside without holding
      // the pointer perfectly still over it.
      const key = this.#houseAt(at.x, at.y);
      if (key) this.pinnedHouse = this.pinnedHouse === key ? null : key;
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

  /** The two houses as the panel needs them: whose kitchen, and who is in there. */
  houseState() {
    return this.houses.map((house) => ({
      key: house.key,
      name: house.plan.name,
      hubId: house.hubId,
      members: [...this.homeOf].filter(([, key]) => key === house.key).map(([id]) => id),
    }));
  }

  /** What this session's own chef has exchanged with it, whichever house that is. */
  connOf(id) {
    return this.#connOf(id);
  }

  select(id) {
    this.selectedId = id;
    // Picking somebody indoors takes the roof off their house and leaves it off.
    const house = id ? (this.#homeOf(id) ?? this.#houseOfHub(id)) : null;
    this.pinnedHouse = house ? house.key : null;
    this.focus(id);
    this.onSelect(id);
  }

  /** The house under a screen point, tested against its real six-sided silhouette. */
  #houseAt(sx, sy) {
    if (!this.district) return null;
    const p = this.#toWorld(sx, sy);
    // Nearest first: where two roofs overlap, the one in front takes the pointer.
    for (let i = this.houses.length - 1; i >= 0; i--) {
      if (inPolygon(p, this.houses[i].silhouette)) return this.houses[i].key;
    }
    return null;
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
    if (this.district) this.#drawWorld(ctx, t, byId);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.#drawGlances(ctx, t);
    this.#drawLabels(ctx, byId);
    this.#drawBubbles(ctx, t, byId);
    this.#drawTooltip(ctx, byId);
    this.#drawToasts(ctx, byId, t);
  }

  /**
   * One pass over the whole district, back to front: the block next door, then the room, then
   * the frontage that divides them, then the street. Within the room and within the street
   * everything is painter-sorted by depth; between the four bands the order is fixed, because
   * a building and a lamp post on the pavement in front of it never need arguing about.
   */
  /**
   * One pass over the whole district, back to front: the ground, the two dining rooms, then the
   * street in front of them.
   *
   * The rooms are painter-sorted with each other, so the right-hand one — which really is
   * nearer the camera — draws over its neighbour where they meet. Whichever room the pointer is
   * on goes last instead, so pointing at a room is always enough to see all of it.
   */
  #drawWorld(b, t, byId) {
    const dist = this.district;
    skyGlow(b, dist);
    drawGround(b, this.ground);

    const front = this.houses.find((house) => house.key === this.#openKey()) ?? null;
    const rooms = [...this.houses].sort((p, q) => p.plan.ox + p.plan.w - (q.plan.ox + q.plan.w));
    for (const house of rooms) if (house !== front) this.#drawInside(b, house, t, byId);
    if (front) this.#drawInside(b, front, t, byId);

    // ── the street ──────────────────────────────────────────────────────────────────────────
    const street = [];
    const out = (x, y, layer, draw) => street.push({ depth: (x + y) * 10 + layer, draw });
    for (const cart of this.carts) {
      // Depth taken at the van's BACK corner: it is a two-tile solid, and everyone who matters
      // is standing in front of it.
      out(cart.x, cart.y, 3, () => foodCart(b, cart, t));
    }
    for (const prop of dist.props) out(prop.x, prop.y, 5, () => streetProp(b, prop, t));
    for (const traffic of this.#traffic(t)) {
      out(traffic.x, traffic.y, 4, () =>
        car(b, traffic.x, traffic.y, traffic.index, traffic.dir, t, traffic.fade),
      );
    }
    for (const [id, place] of this.placement) {
      const agent = byId.get(id);
      if (!agent || this.#homeOf(id) || place.mode === 'walking') continue;
      out(place.tile.x, place.tile.y, 6, () => this.#drawStreetPerson(b, agent, place, t));
    }
    for (const m of this.movers) {
      if (!m.pos || m.pos.y < dist.houseDepth) continue;
      out(m.pos.x, m.pos.y, 6, () => this.#drawWalker(b, m, byId));
    }
    street.sort((p, q) => p.depth - q.depth);
    for (const item of street) item.draw();
    backRailing(b, dist.w, dist.d);
  }

  /** How many sessions a house is holding — what its sign reports while the roof is on. */
  #insideCount(house) {
    let n = 0;
    for (const key of this.homeOf.values()) if (key === house.key) n += 1;
    return n;
  }

  /** One restaurant with its roof off: the room, everyone in it, and the terrace out front. */
  #drawInside(b, house, t, byId) {
    const plan = house.plan;
    const { ox, w, d, gate, chef, lobbyY, entrance, podium, host, station } = plan;

    walls(b, ox, w, d, WALL_H);
    for (let y = 6; y < d - 2; y += 5) wallPicture(b, ox, 0, y, -1, 40, t);
    for (let y = 9; y < d - 2; y += 5) wallLamp(b, ox, 0, y, -1, 48, t);
    for (let x = ox + 1; x + 2 < ox + w; x += 5) shelf(b, ox, x, 0, 1, 42);
    for (let x = ox + 3; x < ox + w - 1; x += 5) wallLamp(b, ox, x, 0, 1, 48, t);

    const items = [];
    const add = (x, y, layer, draw) => items.push({ depth: (x + y) * 10 + layer, draw });

    for (let x = ox; x < ox + w; x++)
      if (x !== gate) add(x, COUNTER_Y, 5, () => counter(b, x, COUNTER_Y));
    add(gate, COUNTER_Y, 0, () => serviceBell(b, gate - 0.5, COUNTER_Y + 0.5, 18));

    const hub = byId.get(house.hubId);
    if (hub) {
      const cooking = hub.status === 'working';
      add(chef.x - 1, chef.y, 3, () => stove(b, chef.x - 1, chef.y, cooking, t));
      add(chef.x, chef.y, 5, () => this.#drawChef(b, house, hub, t));
    }
    add(station.x, station.y, 5, () => cardTable(b, station.x, station.y, t));
    for (const wt of house.waiters) {
      const at = wt.task ? (wt.pos ?? wt.seat) : wt.seat;
      add(at.x, at.y, wt.task ? 6 : 4, () => this.#drawWaiter(b, wt, t));
    }

    // The rope line between the floor and the lobby, with a gap at the entrance.
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
    add(host.x, host.y, 5, () => this.#drawHost(b, house, t));
    add(ox + w - 1, lobbyY + 1, 5, () => plant(b, ox + w - 1, lobbyY + 1));
    add(ox, COUNTER_Y + 1, 5, () => plant(b, ox, COUNTER_Y + 1));

    for (const [id, place] of this.placement) {
      if (this.#homeOf(id) !== house) continue;
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
      if (!m.pos || m.pos.y >= d) continue;
      if (m.pos.x < ox - 0.5 || m.pos.x > ox + w + 0.5) continue;
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
    const { street, w } = this.district;
    const lanes = [
      { y: street.roadY + 0.05, dir: -1, gap: 0 },
      { y: street.roadY + street.roadRows - 1.15, dir: 1, gap: 0.42 },
    ];
    const cars = [];
    lanes.forEach((lane, index) => {
      const phase = (t / (CAR_PERIOD + index * 6500) + lane.gap) % 1;
      if (phase > 0.5) return; // the road is empty half the time
      const k = phase * 2;
      const from = -4;
      const to = w - 1;
      const x = lane.dir > 0 ? from + k * (to - from) : to - k * (to - from);
      cars.push({
        x,
        y: lane.y,
        index,
        dir: lane.dir,
        // The road is only paved between 0 and w; a car arrives and leaves through a fade
        // rather than driving off the end of it.
        fade: Math.max(0, Math.min(1, (x - from) / 3, (to - x) / 3)),
      });
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

  /**
   * Someone out on the street. Turned toward the van while they are waiting their turn, turned
   * back around with the food once they have it — which is the whole status story out here,
   * the same way a table and the line are the whole story inside.
   */
  #drawStreetPerson(b, agent, place, t) {
    const cart = this.#cartOfAgent(agent.id);
    const eating = place.mode === 'eating';
    b.save();
    if (this.#emphasis(agent.id) < 1) b.globalAlpha = 0.6;
    if (agent.status === 'exited') b.globalAlpha *= 0.5;
    const anchors = this.#person(
      b,
      agent,
      place.tile.x,
      place.tile.y,
      { facing: eating ? 'front' : 'back' },
      t,
    );
    if (eating && agent.status === 'working') {
      streetFood(b, anchors.handX, anchors.handY - 2, cart?.emblem, t);
    }
    if (agent.status === 'waiting') {
      const look = lookFor(agent.id);
      const raise = Math.round(Math.abs(Math.sin(t / 220)) * 2);
      b.fillStyle = look.body;
      b.fillRect(anchors.handX + 1, anchors.handY - 14 - raise, 3, 12);
      b.fillStyle = look.skin;
      b.fillRect(anchors.handX, anchors.handY - 18 - raise, 5, 5);
      exclaim(b, anchors.headX + 11, anchors.headY - 6, t);
    }
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

  #drawChef(b, house, hub, t) {
    const { chef } = house.plan;
    const pal = chefPalette(hub.id);
    const pose = house.chefPose && t < house.chefPose.until ? house.chefPose : null;
    const anchors = figure(b, chef.x, chef.y, pal, { facing: 'front', hat: 'chef' });
    house.chefAnchors = anchors;
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

  #drawHost(b, house, t) {
    const { host } = house.plan;
    const pal = hostPalette();
    const anchors = figure(b, host.x, host.y, pal, { facing: 'front' });
    b.fillStyle = '#1e1a1a';
    b.fillRect(anchors.headX - 2, anchors.headY + 12, 4, 2); // bow tie
    const waving = house.hostPose && t < house.hostPose.until;
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
    const house = this.#houseOfHub(id);
    if (house?.chefAnchors) {
      return this.#toScreen(house.chefAnchors.headX, house.chefAnchors.headY - 8);
    }
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
    if (!this.district) return;
    const zoomedIn = this.camera.zoom >= 2;
    const focus = this.hoverId ?? this.selectedId;
    // Three people at the same cart stand a tile apart, which in the isometry is eight pixels
    // of stagger and nothing like enough for their labels. Anything that would land on top of
    // one already placed is pushed up until it does not.
    const placed = [];
    const clear = (x, y, w, h) =>
      !placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y);
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
        const tag = `CHEF · ${(this.#houseOfHub(agent.id)?.plan.name ?? 'ORCHESTRATOR').toUpperCase()}`;
        const tw = ctx.measureText(tag).width + 14;
        roundRect(ctx, at.x - tw / 2, y - 11, tw, 16, 8);
        ctx.fillStyle = '#c792ea';
        ctx.fill();
        ctx.fillStyle = '#1a1226';
        ctx.fillText(tag, at.x, y - 3);
      }
      ctx.restore();
    };

    // The house titles go down first, so every name that follows knows to dodge them.
    for (const house of this.houses) this.#drawHouseSign(ctx, house, byId, placed);

    // Every name floats over its own head. The line at the door is dense, so zoomed out only
    // the person under the cursor gets one there.
    const k = this.camera.zoom;
    for (const [id, place] of this.placement) {
      const agent = byId.get(id);
      const head = this.#headScreen(id);
      if (!agent || !head) continue;
      const dense = place.mode === 'queued' || place.mode === 'lining';
      if (dense && !zoomedIn && focus !== id) continue;
      draw(agent, { x: head.x, y: head.y - 14 * k - 4 }, false, this.#connOf(id), !zoomedIn);
    }
    for (const house of this.houses) {
      const hub = byId.get(house.hubId);
      const at = this.#headScreen(house.hubId);
      if (hub && at && focus === hub.id) {
        draw(hub, { x: at.x, y: at.y - 14 * k - 6 }, true, null, false);
      }
    }
  }

  /**
   * The name over a restaurant, hung above its back wall where there is nothing to collide
   * with, and under it the state of that orchestration in one line: how many sessions are in
   * there, how many are mid-turn, and whether any of them is waiting on you.
   */
  #drawHouseSign(ctx, house, byId, placed) {
    const plan = house.plan;
    const ridge = iso(plan.ox + plan.w / 2, 0, WALL_H + 30);
    const at = this.#toScreen(ridge.x, ridge.y);
    if (at.x < -180 || at.x > this.canvas.clientWidth + 180) return;
    const inside = this.#insideCount(house);
    const working = [...this.homeOf]
      .filter(([, key]) => key === house.key)
      .filter(([id]) => byId.get(id)?.status === 'working').length;
    const waiting = [...this.homeOf]
      .filter(([, key]) => key === house.key)
      .filter(([id]) => byId.get(id)?.status === 'waiting').length;
    const shut = !house.hubId;
    const sub = shut
      ? 'no orchestrator'
      : `${inside} inside · ${working} working${waiting ? ` · ${waiting} waiting on you` : ''}`;

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
    ctx.globalAlpha = shut ? 0.6 : 1;
    ctx.fillStyle = 'rgba(13,18,26,0.92)';
    ctx.strokeStyle =
      this.hoverHouse === house.key
        ? '#ffd166'
        : shut
          ? 'rgba(255,255,255,0.14)'
          : 'rgba(199,146,234,0.7)';
    ctx.lineWidth = this.hoverHouse === house.key ? 1.6 : 1;
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
    ctx.fillStyle = waiting ? '#ffbf47' : shut ? '#6f7f95' : '#8b9cb3';
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

  #drawTooltip(ctx, byId) {
    const id = this.hoverId;
    if (!id || id === this.selectedId) return;
    const agent = byId.get(id);
    if (!agent) return;
    const status = STATUS[agent.status] ?? STATUS.idle;
    const conn = this.#connOf(id);
    const place = this.placement.get(id);
    ctx.save();
    ctx.font = '500 11.5px ui-sans-serif, system-ui, sans-serif';
    const lines = agent.says ? wrapText(ctx, agent.says, 230, 3) : [];
    const cart = this.#cartOfAgent(id);
    const where =
      place?.mode === 'queued'
        ? 'in line at the door'
        : place?.mode === 'walking'
          ? 'on the way'
          : place?.mode === 'eating'
            ? `at the ${cart?.label ?? 'cart'} van`
            : place?.mode === 'lining'
              ? `queueing at ${cart?.label ?? 'a cart'}`
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
        : [
            {
              text: 'not being orchestrated — out on the street',
              font: '500 10.5px ui-monospace, SFMono-Regular, monospace',
              color: '#8b9cb3',
            },
          ]),
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

/** Ray-casting point-in-polygon, for hit-testing a building's silhouette. */
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

function clamp(zoom) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function short(name) {
  return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}

/**
 * Which cart a session eats at. Superset's ad-hoc sessions carry no project, so they share
 * one van between them — the same rule the project filter in the top bar uses.
 */
function cartKeyOf(agent) {
  return agent.type === 'session' || !agent.project ? NO_PROJECT : agent.project;
}

/** One cart per project with sessions on the street, in a stable order (the nameless one last). */
function planCarts(outsiders) {
  const counts = new Map();
  for (const agent of outsiders) {
    const key = cartKeyOf(agent);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => (a[0] === NO_PROJECT) - (b[0] === NO_PROJECT) || a[0].localeCompare(b[0]))
    .slice(0, MAX_CARTS)
    .map(([key, count]) => ({
      key,
      label: key === NO_PROJECT ? 'Sessions' : key,
      count,
    }));
}

const cartKeyList = (carts) => carts.map((c) => c.key).join('|');
