// The district: one restaurant and the street outside it, laid out on ONE tile grid.
//
// The whole point of a single grid is the walk. A session that has been eating at a table and
// is then picked up by an orchestrator does not blink out of one place and into another: it
// gets up, crosses the dining room and takes a stool at the bar — one BFS over one grid,
// because there is only ever one world.
//
// Geometry only. Nothing here knows about agents, time or the canvas. It answers "where does
// the bar run, where do the tables go, where do the vans park, what can be walked on", and the
// scene puts people on it.

// ── the restaurant, corner by corner ─────────────────────────────────────────────────────────
//
// The room has two halves and they meet at the back-left corner, so neither is ever behind the
// other and there is a way between them.
//
//   THE BAR is an L. Its long leg runs down the LEFT WALL to the top of the lobby; its short
//   arm turns at the corner and runs along the BACK WALL until it reaches the kitchen. Three
//   columns wide down the leg, three rows deep along the arm:
//
//     x = 0  /  y = 0   behind the bar: the bartenders' own lane, and the way through
//     x = 1  /  y = 1   the counter itself
//     x = 2             the stools, down the leg only — the arm is the service end
//     x = 3, 4          the aisle in front of them, which is also the way in from the door
//
//   THE KITCHEN is a small block in the BACK-RIGHT corner, starting at x = FLOOR_X so the bar
//   never has to run in front of it:
//
//     y = 0..2  the stove, the developer's own station, the waiters' card table
//     y = 3     the pass, with a gate at its right-hand end for the waiters
//
// The lane behind the bar runs into the kitchen's back row, so the chef could walk out of the
// kitchen, along behind the bar and all the way down it without crossing the floor once. It
// never does — the chef stays at the stove and the bartenders stay at their patches — but the
// room is built as though it could, which is what makes the two halves read as one place.
//
// Everything from x = FLOOR_X and y = FIRST_TABLE_Y down to the rope line is the dining room,
// and below the rope line is the lobby, the podium and the door onto the street.

export const BAR_LANE_X = 0;
export const BAR_X = 1;
export const STOOL_X = 2;
/** The arm of the L: the lane turns the corner along this row, the counter along the next. */
export const BAR_LANE_Y = 0;
export const BAR_ARM_Y = 1;
/** The first row of stools. The counter's top tile is the elbow, and nobody sits at an elbow. */
export const STOOL_Y0 = 2;
/** The first column that is kitchen or dining room; everything left of it belongs to the bar. */
export const FLOOR_X = 5;

export const KITCHEN_ROWS = 3;
export const COUNTER_Y = 3;
export const FIRST_TABLE_Y = 6;
export const TABLE_GAP = 4;
/** The rope gap, the front door and the crossing all line up, on the aisle beside the bar. */
export const ENTRANCE_X = 4;

/** How tall the restaurant's two back walls stand. The room has no roof and no front. */
export const HOUSE_WALL_H = 72;

/**
 * How much counter the bar always has, however few people are drinking at it.
 *
 * The bar is the half of the picture that has to scale: a fleet can put a lot of sessions under
 * one orchestrator, and every one of them wants a stool. Eleven tiles of counter is ten stools,
 * which is the floor; the room is cut deeper than that whenever the patches ask for it.
 */
const BAR_MIN = 11;

/** Elbow room on the bar between one bartender's patch and the next. */
const BAR_ELBOW = 1;

/** Rows of clear floor between the end of the bar and the rope line. */
const BAR_TO_ROPE = 2;

/** Fewer tables than this and the dining room reads as a corridor rather than a restaurant. */
const MIN_TABLE_COLS = 3;

// ── the street, as bands of rows below the restaurant's frontage ──────────────────────────────

export const WALK_ROWS = 2; // pavement outside the door
export const ROAD_ROWS = 3; // two lanes and the centre line
export const KERB_ROWS = 2; // the near pavement, where the parked cars and the shelter stand
export const CROWD_ROWS = 3; // the far pavement, where the railing runs

/** The tiles the bartenders' patches actually take up, elbow room between them included. */
function barRun(patches) {
  if (!patches.length) return 0;
  const run = patches.reduce((total, patch) => total + Math.max(2, patch.stools) + BAR_ELBOW, 0);
  return run - BAR_ELBOW;
}

/**
 * How much COUNTER this set of patches needs. One tile longer than the stools it has to serve:
 * the counter's top tile is the elbow where the L turns, and nobody sits at an elbow.
 */
export function barWidth(patches) {
  return Math.max(BAR_MIN, barRun(patches) + 1);
}

/**
 * The plan for the whole district.
 *
 * @param {object} options
 * @param {{key: string, name: string, seats: number, bar: {hubId: string, stools: number}[]}} options.house
 *   the restaurant: how many tables it needs, and one patch of bar per orchestrator
 */
export function buildDistrict({ house = {} } = {}) {
  const party = Math.max(1, house.seats ?? 1);
  const patches = house.bar ?? [];

  // The room is cut to whichever of its two halves is hungrier. The bar runs down the depth, so
  // a busy bar makes the room DEEPER — and the dining room then gets NARROWER to match, laying
  // the same tables out in more rows of fewer columns. Growing both ways at once is what turns
  // a restaurant into an aircraft hangar with eight people in it.
  const square = Math.max(2, Math.ceil(Math.sqrt(party * 1.4)));
  const rowsForBar =
    Math.ceil((barWidth(patches) + BAR_TO_ROPE - FIRST_TABLE_Y - 2) / TABLE_GAP) + 1;
  const rows = Math.max(1, Math.ceil(party / square), rowsForBar);
  const cols = Math.max(MIN_TABLE_COLS, Math.ceil(party / rows));

  const lobbyY = FIRST_TABLE_Y + (rows - 1) * TABLE_GAP + 2;
  // One row deeper than the rope line's lobby, so the doorway is not also somebody's place
  // in the queue.
  const rd = lobbyY + 5;

  const hw = FLOOR_X + cols * TABLE_GAP + 3;
  const plan = planHouse({ ...house, cols, rows, bar: patches }, 0, hw, lobbyY, rd);

  const walkY = rd;
  const roadY = rd + WALK_ROWS;
  const kerbY = roadY + ROAD_ROWS;
  const crowdY = kerbY + KERB_ROWS;
  const d = crowdY + CROWD_ROWS;

  // The street has to run wider than the building does. Each row of it toward the camera shifts
  // half a tile left on screen, so a pavement that ends where the frontage ends visibly falls
  // short of it by exactly the depth of the street.
  const w = hw + (d - rd);

  const street = {
    walkY,
    walkRows: WALK_ROWS,
    roadY,
    roadRows: ROAD_ROWS,
    kerbY,
    kerbRows: KERB_ROWS,
    crowdY,
    crowdRows: CROWD_ROWS,
    // A zebra in front of the door, which is what makes the frontage read as an entrance.
    crossings: [{ x0: plan.door.x - 1, x1: plan.door.x + 2 }],
  };

  const props = planProps({ w, street, plan });
  const { blocked, blockedStaff } = planBlocking({ w, d, plan, rd, street });

  return {
    w,
    d,
    houseDepth: rd,
    house: plan,
    street,
    props,
    blocked,
    blockedStaff,
  };
}

/**
 * The restaurant: its bar, its kitchen, its tables, its lobby, and the door onto the street.
 *
 * The bar is one continuous run down the left wall, divided into patches, one per orchestrator:
 * the bartender stands behind the middle of its own patch and the stools beside it are for the
 * sessions that bartender is driving. Patches are laid back to front in election order, so the
 * longest-standing orchestrator keeps its end of the bar as others start pouring.
 */
function planHouse(spec, ox, w, lobbyY, rd) {
  // The kitchen is a corner, not a wall: three rows in the back right, ending at the gate the
  // waiters come out through. Everything it gave up went to the bar.
  const chefX = ox + Math.max(FLOOR_X + 1, w - 6);
  const chef = { x: chefX, y: 1 };
  const station = { x: ox + w - 2, y: 1 };
  const entranceX = ox + ENTRANCE_X;

  // The bar runs the full depth it is allowed, however few people are drinking at it: a room
  // with three stools huddled in one corner reads as a serving hatch, not as a bar. Every tile
  // of it gets a stool, and the patches are then centred along that run, so one bartender on
  // its own stands in the middle rather than at one end.
  const barLen = Math.max(BAR_MIN, lobbyY - BAR_TO_ROPE - BAR_ARM_Y);
  const lastY = BAR_ARM_Y + barLen - 1;
  const stools = [];
  for (let y = STOOL_Y0; y <= lastY; y++) stools.push({ x: ox + STOOL_X, y });

  const patches = [];
  let cursor = Math.max(0, Math.floor((stools.length - barRun(spec.bar ?? [])) / 2));
  for (const patch of spec.bar ?? []) {
    const len = Math.max(2, patch.stools);
    if (cursor + len > stools.length) break; // no bar left: this orchestrator waits for room
    const seats = stools.slice(cursor, cursor + len);
    patches.push({
      hubId: patch.hubId,
      len,
      stools: seats,
      tender: { x: ox + BAR_LANE_X, y: seats[Math.floor((len - 1) / 2)].y },
    });
    cursor += len + BAR_ELBOW;
  }
  const bar = {
    x: ox + BAR_X,
    lane: ox + BAR_LANE_X,
    stoolX: ox + STOOL_X,
    y0: BAR_ARM_Y,
    laneY: BAR_LANE_Y,
    len: barLen,
    // The arm turns the corner and runs INTO the kitchen block, which is what joins them.
    armTo: ox + FLOOR_X,
    stools,
    patches,
  };

  // Tables row by row, bar side first, each row filled from the centre outward — so the first
  // tables handed out are the good ones.
  const slots = [];
  for (let j = 0; j < spec.rows; j++) {
    const order = [];
    let left = Math.floor((spec.cols - 1) / 2);
    let right = left + 1;
    for (let i = 0; i < spec.cols; i++) order.push(i % 2 === 0 ? left-- : right++);
    for (const i of order) {
      slots.push({ tx: ox + FLOOR_X + 1 + i * TABLE_GAP, ty: FIRST_TABLE_Y + j * TABLE_GAP });
    }
  }

  return {
    key: spec.key,
    name: spec.name,
    ox,
    w,
    d: rd,
    slots,
    bar,
    gate: ox + w - 2,
    chef,
    pickup: { x: chefX, y: 2 },
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
 * Street furniture. Nothing out here is an agent any more — the vans went when the last session
 * came indoors — so the pavement has to hold the picture up on its own: a shelter, a kiosk, a
 * phone box, trees, and a few cars parked along the kerb.
 *
 * The big pieces are placed at fractions of the frontage rather than at fixed pitches, so a
 * narrow street gets the same three landmarks spread across it as a wide one does.
 */
function planProps({ w, street, plan }) {
  const props = [];
  const { walkY, roadY, roadRows, kerbY, crowdY, crowdRows } = street;
  const backEdge = crowdY + crowdRows - 1;
  const clearOfDoor = (x) => Math.abs(x - plan.door.x) > 2;
  const at = (fraction) => Math.max(2, Math.min(w - 4, Math.round(w * fraction)));

  // The far pavement, in front of the frontage, kept clear of the door.
  for (let x = 4; x < w - 1; x += 8)
    if (clearOfDoor(x)) props.push({ kind: 'lamp', x, y: walkY + 1 });
  for (let x = 3; x < w - 2; x += 10)
    if (clearOfDoor(x)) props.push({ kind: 'bin', x, y: walkY + 1 });
  for (let x = 7; x < w - 3; x += 11)
    if (clearOfDoor(x)) props.push({ kind: 'bench', x, y: walkY });
  for (let x = 2; x < w - 2; x += 9) if (clearOfDoor(x)) props.push({ kind: 'tree', x, y: walkY });
  props.push({ kind: 'hydrant', x: at(0.62), y: walkY + 1 });
  props.push({ kind: 'trafficLight', x: Math.max(2, plan.door.x - 4), y: walkY + 1 });

  // The near pavement: three landmarks, spread out, with the parked cars between them.
  // Kept off the crossing, which is the one stretch of kerb that has to stay walkable.
  const offCrossing = (x) => (clearOfDoor(x) ? x : x + 4 < w - 4 ? x + 4 : x - 4);
  props.push({ kind: 'busStop', x: offCrossing(at(0.12)), y: kerbY });
  props.push({ kind: 'newsstand', x: offCrossing(at(0.46)), y: kerbY });
  props.push({ kind: 'phoneBox', x: offCrossing(at(0.8)), y: kerbY });
  // Parked in the road hard against the kerb, which is where a parked car goes: the near row of
  // the carriageway is the parking lane, and the traffic keeps to the two rows behind it.
  for (const fraction of [0.36, 0.66, 0.9]) {
    props.push({
      kind: 'parked',
      x: at(fraction),
      y: roadY + roadRows - 1.15,
      index: Math.round(fraction * 7),
    });
  }
  for (let x = 6; x < w - 2; x += 11) props.push({ kind: 'bin', x, y: kerbY + 1 });
  for (let x = 9; x < w - 2; x += 12) props.push({ kind: 'bollard', x, y: crowdY });

  // The back edge of the world, where the railing runs.
  for (let x = 1; x < w - 1; x += 9) props.push({ kind: 'lamp', x, y: backEdge });
  for (let x = 6; x < w - 2; x += 13) props.push({ kind: 'bench', x, y: backEdge });
  for (let x = 4; x < w - 2; x += 11) props.push({ kind: 'tree', x, y: backEdge });

  props.push({ kind: 'drain', x: at(0.33), y: roadY + roadRows - 1 });
  props.push({ kind: 'pigeon', x: 9.4, y: backEdge + 0.3 });
  props.push({ kind: 'pigeon', x: 10.1, y: backEdge + 0.7 });
  props.push({ kind: 'pigeon', x: at(0.5) - 2.6, y: crowdY + 2.4 });
  return props;
}

/**
 * Two maps of what cannot be walked through. Guests may not enter the kitchen, may not get
 * behind the bar and may not leave the building; staff may use the kitchen and the back of the
 * bar but not the stove, the chef, the card table or the pass, and never go outdoors.
 */
function planBlocking({ w, d, plan, rd, street }) {
  const blocked = new Set();
  const blockedStaff = new Set();
  const block = (x, y, staffToo = true) => {
    blocked.add(`${x},${y}`);
    if (staffToo) blockedStaff.add(`${x},${y}`);
  };

  // Everything on the building's rows is a wall until the room says otherwise.
  for (let x = 0; x < w; x++) for (let y = 0; y < rd; y++) block(x, y);

  const { ox, w: hw, lobbyY, chef, station, podium, host, gate, entrance, slots, bar } = plan;
  for (let x = ox; x < ox + hw; x++) {
    for (let y = 0; y < rd; y++) {
      blocked.delete(`${x},${y}`);
      blockedStaff.delete(`${x},${y}`);
    }
  }

  // The kitchen and the pass, in the back-right corner only. The kitchen is staff country: a
  // waiter walks it, a guest does not. The pass is solid to everybody but the gate.
  for (let x = ox + FLOOR_X; x < ox + hw; x++) {
    for (let y = 0; y < KITCHEN_ROWS; y++) block(x, y, false);
    if (x !== gate) block(x, COUNTER_Y);
  }
  block(chef.x - 1, chef.y);
  block(chef.x, chef.y);
  block(station.x, station.y);

  // The bar, an L down the left wall and along the back. Behind it is the bartenders' own lane
  // and nobody else's — a guest may not get behind a bar, but the kitchen staff share it, which
  // is the corridor that joins the two halves of the room. The counter and the stools are
  // furniture to everyone.
  for (let y = bar.laneY; y < bar.y0 + bar.len; y++) {
    block(bar.lane, y, false);
    if (y >= bar.y0) block(bar.x, y);
  }
  for (let x = bar.lane; x <= bar.armTo; x++) {
    block(x, bar.laneY, false);
    if (x >= bar.x) block(x, bar.y0);
  }
  for (const stool of bar.stools) block(stool.x, stool.y);

  // The rope line across the room, with a gap at the entrance.
  for (let x = ox; x < ox + hw; x++) if (x !== entrance.x) block(x, lobbyY);
  for (const s of slots) {
    block(s.tx, s.ty);
    block(s.tx, s.ty - 1);
  }
  block(podium.x, podium.y);
  block(host.x, host.y);

  // The road is for traffic. The crossing is not.
  const onCrossing = (x) => street.crossings.some((c) => x >= c.x0 && x <= c.x1);
  for (let x = 0; x < w; x++) {
    for (let y = street.roadY; y < street.roadY + street.roadRows; y++) {
      if (!onCrossing(x)) block(x, y);
      else blockedStaff.add(`${x},${y}`);
    }
  }
  // Waiters stay indoors: the whole outdoors is a wall to them.
  for (let x = 0; x < w; x++) for (let y = rd; y < d; y++) blockedStaff.add(`${x},${y}`);

  return { blocked, blockedStaff };
}
