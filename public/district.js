// The district: the restaurants and the street outside them, laid out on ONE tile grid.
//
// The whole point of a single grid is the walk. A session that has been eating from a cart on
// the pavement and is then picked up by an orchestrator does not blink out of one scene and
// into another: it puts its food down, crosses the road at that restaurant's crossing, and
// comes in through its door — one BFS over one grid, because there is only ever one world.
//
// Geometry only. Nothing here knows about agents, time or the canvas. It answers "where do the
// tables go, where do the vans park, what can be walked on", and the scene puts people on it.

import { hash } from './draw.js';

// ── the restaurants ──────────────────────────────────────────────────────────────────────────

export const KITCHEN_ROWS = 4; // y = 0..3 is the kitchen; the counter runs along y = 4
export const COUNTER_Y = 4;
export const FIRST_TABLE_Y = 8;
export const TABLE_GAP = 4;
export const ENTRANCE_X = 2; // the rope gap, the front door and the crossing all line up

/** How tall a restaurant's two back walls stand. The rooms have no roof and no front. */
export const HOUSE_WALL_H = 72;

/**
 * The alley between the two restaurants.
 *
 * Five tiles, and the number is not arbitrary. In this projection the right-hand room is nearer
 * the camera, so its left wall rises in front of its neighbour's floor; at the same screen
 * column that wall's base sits sixteen pixels lower for every tile of gap. At five tiles it is
 * eighty pixels down, the wall is seventy-two tall, and its top clears the neighbour's floor
 * entirely. Any closer and one dining room starts eating into the other.
 */
const HOUSE_GAP = 5;

// ── the street, as bands of rows below the restaurants' frontage ─────────────────────────────

export const WALK_ROWS = 2; // pavement outside the doors
export const ROAD_ROWS = 3; // two lanes and the centre line
export const CART_ROWS = 2; // the vans stand on the near pavement, hard against the kerb
export const CROWD_ROWS = 3; // where everyone eating from a cart stands

const CART_W = 3;
const CART_MIN_PITCH = 6;
const CART_X0 = 2;
const MIN_CARTS = 3; // a street with one van on it does not read as a street
export const MAX_CARTS = 7;

/**
 * Emblems a cart can wear. Which one a project gets is derived from its name, so a project
 * keeps its van — and its colours — for as long as the name does.
 */
const EMBLEMS = ['taco', 'bowl', 'cup', 'burger', 'chili', 'fish', 'pretzel', 'star'];

// `body` paints the van, `trim` the awning stripes and the lettering, `ink` the name board
// behind it. The trim has to hold its own against the cream of the canopy, so none of these
// is a near-white: a pale trim makes the stripes and the cart's name vanish.
const SKINS = [
  { body: '#d94f3d', trim: '#ffd166', ink: '#3a1512' },
  { body: '#2f7f6f', trim: '#f9c74f', ink: '#0f2b26' },
  { body: '#3d5a9e', trim: '#ffb347', ink: '#131f3d' },
  { body: '#c9762b', trim: '#5ec8a6', ink: '#3a2109' },
  { body: '#7d4a9e', trim: '#ffc2e2', ink: '#2a1338' },
  { body: '#2b7dd6', trim: '#ff9f43', ink: '#0d2b4a' },
  { body: '#4a8f3c', trim: '#ffe066', ink: '#16300f' },
];

/** The vans that are only ever scenery: shutters down, no queue, nobody home. */
const SHUTTERED = [
  { label: 'Nite Owl Coffee', emblem: 'cup' },
  { label: 'Pretzel Wagon', emblem: 'pretzel' },
  { label: 'Dumpling Bros', emblem: 'bowl' },
  { label: 'Chili Sister', emblem: 'chili' },
  { label: 'Fry Street', emblem: 'fish' },
];

// `hash` returns a full unsigned 32-bit value, so anything derived from it is shifted
// unsigned and taken modulo — a signed shift here indexes off the front of the list.
const pick = (list, n) => list[(n >>> 0) % list.length];

/**
 * The plan for the whole district.
 *
 * @param {object} options
 * @param {{key: string, name: string, seats: number, skin: object}[]} options.houses
 *   the restaurants, in the order they stand along the street, left to right
 * @param {{key: string, label: string, count: number}[]} options.carts one per project outside
 */
export function buildDistrict({ houses = [], carts = [] } = {}) {
  const specs = houses.map((house) => {
    const party = Math.max(1, house.seats ?? 1);
    const cols = Math.max(2, Math.ceil(Math.sqrt(party * 1.4)));
    return { ...house, cols, rows: Math.max(1, Math.ceil(party / cols)) };
  });

  // Both houses front the same pavement, so they are cut to the same depth — the taller party
  // decides how many rows of tables there are and the other gets the same room with fewer.
  const rows = Math.max(1, ...specs.map((spec) => spec.rows));
  const lobbyY = FIRST_TABLE_Y + (rows - 1) * TABLE_GAP + 2;
  // One row deeper than the rope line's lobby, so the doorway is not also somebody's place
  // in the queue.
  const rd = lobbyY + 5;

  const plans = [];
  let cursor = 0;
  specs.forEach((spec) => {
    const hw = spec.cols * TABLE_GAP + 3;
    plans.push(planHouse(spec, cursor, hw, rows, lobbyY, rd));
    cursor += hw + HOUSE_GAP;
  });
  const blockEnd = cursor - HOUSE_GAP;

  const walkY = rd;
  const roadY = rd + WALK_ROWS;
  const cartY = roadY + ROAD_ROWS;
  const crowdY = cartY + CART_ROWS;
  const d = crowdY + CROWD_ROWS;

  // The vans are spaced to fill whatever frontage the block turns out to have, rather than
  // parked nose to tail at one end of an otherwise empty street.
  // The street has to run wider than the buildings do. Each row of it toward the camera shifts
  // half a tile left on screen, so a pavement that ends where the last frontage ends visibly
  // falls short of it by exactly the depth of the street.
  const cartSpecs = specCarts(carts);
  const w = Math.max(blockEnd + (d - rd), CART_X0 + CART_MIN_PITCH * cartSpecs.length + 3);
  const pitch = Math.max(CART_MIN_PITCH, Math.floor((w - CART_X0 - 4) / cartSpecs.length));
  const stalls = placeCarts(cartSpecs, pitch, cartY, crowdY);

  const street = {
    walkY,
    walkRows: WALK_ROWS,
    roadY,
    roadRows: ROAD_ROWS,
    cartY,
    crowdY,
    crowdRows: CROWD_ROWS,
    // A zebra in front of each door, which is what makes the walk in read as a walk in.
    crossings: plans.map((plan) => ({ x0: plan.door.x - 1, x1: plan.door.x + 2 })),
  };

  const props = planProps({ w, street, plans, stalls });
  const { blocked, blockedStaff } = planBlocking({ w, d, plans, rd, street, stalls });

  return {
    w,
    d,
    houseDepth: rd,
    houses: plans,
    // The alley between the rooms gets a surface of its own, so the gap reads as a gap rather
    // than as a hole punched through the block.
    alley: { from: plans[0].ox, to: blockEnd },
    street,
    carts: stalls,
    props,
    blocked,
    blockedStaff,
  };
}

/** One restaurant: its kitchen, its tables, its lobby, and the door it opens onto the street. */
function planHouse(spec, ox, w, rows, lobbyY, rd) {
  const chefX = ox + Math.max(2, Math.floor(w / 2) - 2);
  const chef = { x: chefX, y: 2 };
  const station = { x: chefX + 4, y: 1 };
  const entranceX = ox + ENTRANCE_X;

  // Tables row by row, kitchen side first, each row filled from the centre outward — so the
  // first tables handed out are the good ones.
  const slots = [];
  for (let j = 0; j < rows; j++) {
    const order = [];
    let left = Math.floor((spec.cols - 1) / 2);
    let right = left + 1;
    for (let i = 0; i < spec.cols; i++) order.push(i % 2 === 0 ? left-- : right++);
    for (const i of order) {
      slots.push({ tx: ox + 2 + i * TABLE_GAP, ty: FIRST_TABLE_Y + j * TABLE_GAP });
    }
  }

  return {
    key: spec.key,
    name: spec.name,
    skin: spec.skin,
    ox,
    w,
    d: rd,
    slots,
    gate: ox + w - 2,
    chef,
    pickup: { x: chefX, y: 3 },
    station,
    // Around the card table, on its far sides, so the table hides their laps like a diner's.
    waiterSeats: [
      { x: station.x - 1, y: station.y },
      { x: station.x, y: station.y - 1 },
      { x: station.x - 1, y: station.y - 1 },
    ],
    lobbyY,
    entrance: { x: entranceX, y: lobbyY },
    podium: { x: entranceX - 1, y: lobbyY + 2 },
    host: { x: entranceX - 1, y: lobbyY + 1 },
    door: { x: entranceX, y: rd - 1 },
    step: { x: entranceX, y: rd }, // the pavement tile the door opens onto
  };
}

/**
 * One van per project on the street, then shuttered vans until the kerb looks like a kerb. A
 * project keeps its emblem and its paint because both come from a hash of its name.
 */
function specCarts(carts) {
  const real = carts.slice(0, MAX_CARTS).map((cart) => {
    const h = hash(cart.key || 'no-project');
    return {
      key: cart.key,
      label: cart.label,
      count: cart.count ?? 0,
      emblem: pick(EMBLEMS, h),
      skin: pick(SKINS, h >>> 5),
      closed: false,
    };
  });
  const stalls = [...real];
  for (let i = 0; stalls.length < MIN_CARTS; i++) {
    const filler = pick(SHUTTERED, i);
    stalls.push({
      key: `closed:${i}`,
      label: filler.label,
      count: 0,
      emblem: filler.emblem,
      skin: pick(SKINS, i * 3 + 2),
      closed: true,
    });
  }
  return stalls;
}

/** Park the vans along the kerb, evenly, and work out where their customers stand. */
function placeCarts(stalls, pitch, cartY, crowdY) {
  return stalls.map((cart, index) => {
    const x = CART_X0 + index * pitch;
    return {
      ...cart,
      index,
      x,
      y: cartY,
      w: CART_W,
      d: CART_ROWS,
      // Three at the hatch eating, then two rows waiting their turn behind them — filled from
      // the middle out, so one person on their own is standing at the van and not beside it.
      eat: [0, 1, 2].map((i) => ({ x: x + i, y: crowdY })),
      queue: [1, 2].flatMap((row) => [1, 0, 2, -1, 3].map((i) => ({ x: x + i, y: crowdY + row }))),
    };
  });
}

/** Street furniture: lamps, benches, bins, planters, and a few pigeons who live here. */
function planProps({ w, street, plans, stalls }) {
  const props = [];
  const { walkY, crowdY, crowdRows } = street;
  const nearWalk = street.cartY;
  const backEdge = crowdY + crowdRows - 1;
  const doors = plans.map((plan) => plan.door.x);
  const clearOfDoors = (x) => doors.every((dx) => Math.abs(x - dx) > 2);

  for (let x = 4; x < w - 1; x += 7)
    if (clearOfDoors(x)) props.push({ kind: 'lamp', x, y: walkY + 1 });
  for (let x = 1; x < w - 1; x += 9) props.push({ kind: 'lamp', x, y: backEdge });

  // Between the vans there is room for the things a pavement collects.
  for (const cart of stalls) {
    props.push({ kind: 'board', x: cart.x + cart.w, y: nearWalk });
    props.push({ kind: 'bin', x: cart.x - 1, y: nearWalk + 1 });
  }
  // The far pavement, in front of the two frontages, kept clear of both doors.
  for (let x = 3; x < w - 2; x += 7)
    if (clearOfDoors(x)) props.push({ kind: 'bin', x, y: walkY + 1 });
  for (let x = 6; x < w - 3; x += 11)
    if (clearOfDoors(x)) props.push({ kind: 'bench', x, y: walkY });
  for (let x = 2; x < w - 2; x += 5)
    if (clearOfDoors(x)) props.push({ kind: 'planter', x, y: walkY });
  props.push({ kind: 'hydrant', x: Math.max(1, Math.floor(w / 2)), y: walkY + 1 });
  for (let x = 6; x < w - 2; x += 11) props.push({ kind: 'bench', x, y: backEdge });
  for (let x = 4; x < w - 2; x += 9) props.push({ kind: 'planter', x, y: backEdge });
  props.push({
    kind: 'drain',
    x: Math.max(2, Math.floor(w / 3)),
    y: street.roadY + street.roadRows - 1,
  });
  props.push({ kind: 'pigeon', x: 9.4, y: backEdge + 0.3 });
  props.push({ kind: 'pigeon', x: 10.1, y: backEdge + 0.7 });
  props.push({ kind: 'pigeon', x: Math.floor(w / 2) - 2.6, y: crowdY + 2.4 });
  return props;
}

/**
 * Two maps of what cannot be walked through. Guests may not enter a kitchen and may only cross
 * the road on a crossing; staff may use their own kitchen but not the stove, the chef, the card
 * table or the counter, and never leave the building at all.
 */
function planBlocking({ w, d, plans, rd, street, stalls }) {
  const blocked = new Set();
  const blockedStaff = new Set();
  const block = (x, y, staffToo = true) => {
    blocked.add(`${x},${y}`);
    if (staffToo) blockedStaff.add(`${x},${y}`);
  };

  // Everything on the houses' rows is a building until a house says otherwise.
  for (let x = 0; x < w; x++) for (let y = 0; y < rd; y++) block(x, y);

  for (const plan of plans) {
    const { ox, w: hw, lobbyY, chef, station, podium, host, gate, entrance, slots } = plan;
    for (let x = ox; x < ox + hw; x++) {
      for (let y = 0; y < rd; y++) {
        blocked.delete(`${x},${y}`);
        blockedStaff.delete(`${x},${y}`);
      }
    }
    for (const s of slots) {
      block(s.tx, s.ty);
      block(s.tx, s.ty - 1);
    }
    for (let x = ox; x < ox + hw; x++) {
      for (let y = 0; y < COUNTER_Y; y++) block(x, y, false);
      if (x !== gate) block(x, COUNTER_Y);
      if (x !== entrance.x) block(x, lobbyY);
    }
    block(chef.x - 1, chef.y);
    block(chef.x, chef.y);
    block(station.x, station.y);
    block(podium.x, podium.y);
    block(host.x, host.y);
  }
  // The road is for traffic. The crossings are not.
  const onCrossing = (x) => street.crossings.some((c) => x >= c.x0 && x <= c.x1);
  for (let x = 0; x < w; x++) {
    for (let y = street.roadY; y < street.roadY + street.roadRows; y++) {
      if (!onCrossing(x)) block(x, y);
      else blockedStaff.add(`${x},${y}`);
    }
  }
  for (const cart of stalls) {
    for (let x = cart.x; x < cart.x + cart.w; x++)
      for (let y = cart.y; y < cart.y + cart.d; y++) block(x, y);
  }

  // Waiters stay indoors: the whole outdoors is a wall to them.
  for (let x = 0; x < w; x++) for (let y = rd; y < d; y++) blockedStaff.add(`${x},${y}`);

  return { blocked, blockedStaff };
}
