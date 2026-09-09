// Pixel art for the restaurant: the room, the furniture and the people.
//
// Everything here is drawn with whole-pixel coordinates in world units, onto a canvas the
// scene has already scaled to the current zoom. Figures are hand-built character maps — one
// character per pixel — so a shirt colour or a chef's hat is a palette swap and not a new
// drawing. The exterior half of the world is in street.js and shares these primitives.

export const TILE_W = 32; // one floor tile, in world units: a 2:1 diamond. One unit is one
// pixel of the art; the camera scales the whole canvas, so a unit is as many screen pixels
// as the zoom says.
export const TILE_H = 16;

/** Tile coordinates to buffer pixels. `z` lifts a point straight up off the floor. */
export function iso(x, y, z = 0) {
  return { x: Math.round((x - y) * (TILE_W / 2)), y: Math.round((x + y) * (TILE_H / 2) - z) };
}

export const STATUS = {
  working: { color: '#5ee08a', label: 'eating', sub: 'working' },
  waiting: { color: '#ffbf47', label: 'calling the waiter', sub: 'waiting on you' },
  idle: { color: '#7d8da3', label: 'resting', sub: 'idle' },
  exited: { color: '#4a5566', label: 'left', sub: 'exited' },
};

export const FLAVOR = {
  claude: { body: '#e08a5f', trim: '#b8613f', hair: '#3b2a22', label: 'Claude' },
  codex: { body: '#4fb8aa', trim: '#378a7f', hair: '#2a2f3d', label: 'Codex' },
  unknown: { body: '#8f84b8', trim: '#6b6190', hair: '#33283f', label: 'agent' },
};

export const KIND_COLOR = {
  send: '#ffd166',
  inbox: '#ffd166',
  dispatch: '#ffd166',
  report: '#5ee08a',
  read: '#5aa9e6',
  spawn: '#c792ea',
  waiting: '#ffbf47',
};

export const C = {
  outline: '#1e1a1a',
  skin: '#f0c9a4',
  skinShade: '#d9a97f',
  white: '#f6f6f2',
  grey: '#c9ccd2',
  black: '#26262b',
  red: '#d9413b',
  pants: '#3a4a6b',
  shoe: '#2a2320',
  wood: '#8a5a3a',
  woodDark: '#6a4128',
  woodLight: '#a8724b',
  floorA: '#c9a36c',
  floorB: '#c19b64',
  floorLine: '#a98653',
  kitchenA: '#e9eef2',
  kitchenB: '#cfd8e0',
  wall: '#efe0bd',
  wallStripe: '#e2cf9f',
  wallBase: '#8a6d4a',
  wallEdge: '#5f4a32',
  counter: '#5d6b7a',
  counterTop: '#b8c4cf',
  counterEdge: '#3f4a56',
  cloth: '#d9413b',
  clothWhite: '#fbf3ea',
  plate: '#f5f5f0',
  plateRim: '#cfd3d8',
  food1: '#e07b2a',
  food2: '#7cb342',
  food3: '#c62828',
  steel: '#9aa5b1',
  steelDark: '#5f6a76',
  plant: '#3fa34d',
  plantDark: '#2b7a3a',
  pot: '#a05a2c',
  water: '#4aa3df',
};

// ── pixel primitives ─────────────────────────────────────────────────────────────────────────

export function px(ctx, x, y, color, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

/** Draw a character map at (x, y) = top-left, with a palette mapping map chars to colours. */
export function blitMap(ctx, map, x, y, palette, flip = false) {
  const w = map[0].length;
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    for (let c = 0; c < w; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      const color = palette[ch];
      if (!color) continue;
      px(ctx, x + (flip ? w - 1 - c : c), y + r, color);
    }
  }
}

/** A floor tile diamond whose top corner is at (x, y). */
export function floorTile(ctx, x, y, fill, line) {
  const p = iso(x, y);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2);
  ctx.lineTo(p.x, p.y + TILE_H);
  ctx.lineTo(p.x - TILE_W / 2, p.y + TILE_H / 2);
  ctx.closePath();
  ctx.fill();
  if (line) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * A box standing on tile (x, y) with a footprint of w×d tiles and height h pixels. The three
 * visible faces get three shades, which is all the lighting a Habbo room has.
 */
export function isoBox(ctx, x, y, w, d, h, top, right, left, z = 0) {
  const a = iso(x, y, z);
  const b = iso(x + w, y, z);
  const c = iso(x + w, y + d, z);
  const dd = iso(x, y + d, z);
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.moveTo(dd.x, dd.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(c.x, c.y - h);
  ctx.lineTo(dd.x, dd.y - h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(b.x, b.y - h);
  ctx.lineTo(c.x, c.y - h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = top;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - h);
  ctx.lineTo(b.x, b.y - h);
  ctx.lineTo(c.x, c.y - h);
  ctx.lineTo(dd.x, dd.y - h);
  ctx.closePath();
  ctx.fill();
}

// ── the room ─────────────────────────────────────────────────────────────────────────────────

/** A brass post with a red velvet rope to the previous post — the line between lobby and floor. */
export function ropePost(ctx, x, y, prev) {
  const p = iso(x, y);
  if (prev) {
    const q = iso(prev.x, prev.y);
    ctx.strokeStyle = '#b3262a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(q.x, q.y - 16);
    ctx.quadraticCurveTo((p.x + q.x) / 2, (p.y + q.y) / 2 - 10, p.x, p.y - 16);
    ctx.stroke();
  }
  px(ctx, p.x - 3, p.y - 2, '#8a6d1a', 6, 2);
  px(ctx, p.x - 1, p.y - 18, '#d4a73a', 2, 16);
  px(ctx, p.x - 2, p.y - 20, '#f2cf5a', 4, 3);
}

/** The maître d's podium at the entrance: a lectern with a little lamp and the bookings. */
export function hostStand(ctx, x, y, t) {
  isoBox(ctx, x + 0.2, y + 0.2, 0.6, 0.6, 22, C.woodLight, C.wood, C.woodDark);
  const p = iso(x + 0.5, y + 0.5, 22);
  px(ctx, p.x - 6, p.y - 3, C.white, 9, 6); // the reservations book
  px(ctx, p.x - 5, p.y - 2, '#8b9cb3', 7, 1);
  px(ctx, p.x - 5, p.y, '#8b9cb3', 5, 1);
  px(ctx, p.x + 6, p.y - 2, '#8a6d1a', 1, 8); // lamp stem
  const on = Math.sin(t / 500) > -0.95;
  px(ctx, p.x + 3, p.y - 8, on ? '#ffe9a8' : '#e0c98a', 7, 5);
  px(ctx, p.x + 4, p.y - 7, on ? '#fff6d5' : '#e0c98a', 5, 3);
}

export function doormat(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.5);
  ctx.fillStyle = '#7a2f2f';
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - 6);
  ctx.lineTo(p.x + 12, p.y);
  ctx.lineTo(p.x, p.y + 6);
  ctx.lineTo(p.x - 12, p.y);
  ctx.closePath();
  ctx.fill();
}

/**
 * The two back walls of a room whose left edge is at `ox`, meeting at tile (ox, 0), with
 * wallpaper and a skirting board. Only ever drawn for a house whose roof is off.
 */
export function walls(ctx, ox, w, d, height) {
  const origin = iso(ox, 0);
  const leftEnd = iso(ox, d);
  const rightEnd = iso(ox + w, 0);
  const thickness = 6;

  const wallFace = (from, to, dir) => {
    ctx.fillStyle = C.wall;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(to.x, to.y - height);
    ctx.lineTo(from.x, from.y - height);
    ctx.closePath();
    ctx.fill();
    // Wallpaper stripes, following the wall's slope.
    ctx.fillStyle = C.wallStripe;
    const steps = Math.abs(to.x - from.x) / 8;
    for (let i = 1; i < steps; i += 2) {
      const fx = from.x + dir * i * 8;
      const fy = from.y + (i * 8) / 2;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + dir * 4, fy + 2);
      ctx.lineTo(fx + dir * 4, fy + 2 - height);
      ctx.lineTo(fx, fy - height);
      ctx.closePath();
      ctx.fill();
    }
    // Skirting
    ctx.fillStyle = C.wallBase;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.lineTo(to.x, to.y - 5);
    ctx.lineTo(from.x, from.y - 5);
    ctx.closePath();
    ctx.fill();
  };
  wallFace(origin, leftEnd, -1);
  wallFace(origin, rightEnd, 1);

  // Wall tops (the thin ledge you see from above), and the corner post.
  ctx.fillStyle = C.wallEdge;
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y - height);
  ctx.lineTo(leftEnd.x, leftEnd.y - height);
  ctx.lineTo(leftEnd.x - thickness, leftEnd.y - height - thickness / 2);
  ctx.lineTo(origin.x - thickness, origin.y - height - thickness / 2);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y - height);
  ctx.lineTo(rightEnd.x, rightEnd.y - height);
  ctx.lineTo(rightEnd.x + thickness, rightEnd.y - height - thickness / 2);
  ctx.lineTo(origin.x + thickness, origin.y - height - thickness / 2);
  ctx.closePath();
  ctx.fill();
}

export function wallPicture(ctx, ox, x, y, side, z, t) {
  // A framed picture hung on the left (side=-1, along the x=ox wall) or right wall.
  const p = side < 0 ? iso(ox, y) : iso(x, 0);
  const w = 22;
  const dx = side < 0 ? -1 : 1;
  ctx.fillStyle = C.woodDark;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - z);
  ctx.lineTo(p.x + dx * w, p.y - z + w / 2);
  ctx.lineTo(p.x + dx * w, p.y - z + w / 2 - 18);
  ctx.lineTo(p.x, p.y - z - 18);
  ctx.closePath();
  ctx.fill();
  const g = ctx.createLinearGradient(0, p.y - z - 16, 0, p.y - z + 8);
  g.addColorStop(0, '#78b6e6');
  g.addColorStop(1, `hsl(${(t / 50) % 360}, 60%, 60%)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(p.x + dx * 2, p.y - z - 1 + 1);
  ctx.lineTo(p.x + dx * (w - 2), p.y - z + (w - 2) / 2 - 1 + 1);
  ctx.lineTo(p.x + dx * (w - 2), p.y - z + (w - 2) / 2 - 15);
  ctx.lineTo(p.x + dx * 2, p.y - z - 15);
  ctx.closePath();
  ctx.fill();
}

export function wallLamp(ctx, ox, x, y, side, z, t) {
  const p = side < 0 ? iso(ox, y) : iso(x, 0);
  const flick = Math.sin(t / 300 + x + y) > -0.9;
  px(ctx, p.x - 2, p.y - z, C.woodDark, 5, 3);
  px(ctx, p.x - 4, p.y - z - 8, '#ffe9a8', 9, 8);
  px(ctx, p.x - 3, p.y - z - 7, flick ? '#fff6d5' : '#ffe9a8', 7, 6);
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - z);
  ctx.lineTo(p.x - 18, p.y - z + 30);
  ctx.lineTo(p.x + 18, p.y - z + 30);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── furniture ────────────────────────────────────────────────────────────────────────────────

/** A table with a red-check cloth on tile (x, y), and what is on it for a diner in `status`. */
export function table(ctx, x, y, status, t) {
  isoBox(ctx, x + 0.42, y + 0.42, 0.16, 0.16, 14, C.woodDark, C.woodDark, C.woodDark);
  isoBox(ctx, x + 0.05, y + 0.05, 0.9, 0.9, 3, C.clothWhite, C.cloth, '#b8342f', 14);
  // Check pattern on the cloth top.
  const p = iso(x + 0.5, y + 0.5, 17);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - 7);
  ctx.lineTo(p.x + 14, p.y);
  ctx.lineTo(p.x, p.y + 7);
  ctx.lineTo(p.x - 14, p.y);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = C.cloth;
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      if ((i + j) % 2) continue;
      const q = { x: p.x + (i - j) * 4, y: p.y + (i + j) * 2 };
      ctx.beginPath();
      ctx.moveTo(q.x, q.y - 2);
      ctx.lineTo(q.x + 4, q.y);
      ctx.lineTo(q.x, q.y + 2);
      ctx.lineTo(q.x - 4, q.y);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  // Plate, and the meal on it while the diner is eating.
  const plate = iso(x + 0.5, y + 0.55, 18);
  ctx.fillStyle = C.plateRim;
  ctx.beginPath();
  ctx.ellipse(plate.x, plate.y, 7, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.plate;
  ctx.beginPath();
  ctx.ellipse(plate.x, plate.y - 1, 6, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  if (status === 'working') {
    const bite = Math.floor(t / 700) % 3;
    px(ctx, plate.x - 3, plate.y - 3, C.food1, 3, 2);
    if (bite < 2) px(ctx, plate.x, plate.y - 3, C.food2, 3, 2);
    if (bite < 1) px(ctx, plate.x - 2, plate.y - 1, C.food3, 4, 1);
  }
  // Glass
  px(ctx, plate.x + 10, plate.y - 7, C.grey, 3, 6);
  px(ctx, plate.x + 10, plate.y - 4, C.water, 3, 3);
  // Candle
  px(ctx, plate.x - 12, plate.y - 8, C.white, 2, 6);
  px(ctx, plate.x - 12, plate.y - 10, Math.sin(t / 90) > 0 ? '#ffb02e' : '#ff8a2e', 2, 2);
}

/** A wooden chair on tile (x, y), facing the camera. Drawn before whoever sits on it. */
export function chair(ctx, x, y) {
  isoBox(ctx, x + 0.25, y + 0.25, 0.5, 0.5, 9, C.woodLight, C.wood, C.woodDark);
  // Back rest along the far edge.
  isoBox(ctx, x + 0.25, y + 0.25, 0.5, 0.1, 22, C.woodLight, C.wood, C.woodDark, 9);
}

/** The counter that separates the kitchen: one segment per tile, with a steel top. */
export function counter(ctx, x, y) {
  isoBox(ctx, x, y, 1, 1, 18, C.counterTop, C.counter, C.counterEdge);
}

export function stove(ctx, x, y, cooking, t) {
  isoBox(ctx, x, y, 1, 1, 16, C.steel, C.steelDark, '#4a545f');
  const p = iso(x + 0.5, y + 0.5, 16);
  // Burners
  for (const [dx, dy] of [
    [-6, -2],
    [4, 2],
  ]) {
    ctx.fillStyle = cooking ? '#ff6b3d' : '#2f3740';
    ctx.beginPath();
    ctx.ellipse(p.x + dx, p.y + dy, 4, 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pot on the front burner
  isoBox(ctx, x + 0.5, y + 0.45, 0.4, 0.4, 7, '#3c434c', '#2a3037', '#1f2429', 16);
  if (cooking) {
    for (let i = 0; i < 4; i++) {
      const phase = (t / 900 + i / 4) % 1;
      const sx = p.x + 6 + Math.sin(phase * 6 + i) * 3;
      const sy = p.y - 9 - phase * 22;
      ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - phase)})`;
      ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
    }
  }
}

export function shelf(ctx, ox, x, y, side, z) {
  const p = side < 0 ? iso(ox, y) : iso(x, 0);
  const dx = side < 0 ? -1 : 1;
  ctx.fillStyle = C.woodDark;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - z);
  ctx.lineTo(p.x + dx * 28, p.y - z + 14);
  ctx.lineTo(p.x + dx * 28, p.y - z + 11);
  ctx.lineTo(p.x, p.y - z - 3);
  ctx.closePath();
  ctx.fill();
  // Pans and jars along it.
  for (let i = 0; i < 4; i++) {
    const jx = p.x + dx * (4 + i * 6);
    const jy = p.y - z + (4 + i * 6) / 2 - 3;
    px(ctx, jx, jy - 6, i % 2 ? C.steel : '#d9a441', 3, 6);
  }
}

export function plant(ctx, x, y) {
  isoBox(ctx, x + 0.3, y + 0.3, 0.4, 0.4, 8, C.pot, '#874a22', '#6e3b1a');
  const p = iso(x + 0.5, y + 0.5, 8);
  for (const [dx, dy, c] of [
    [-5, -8, C.plantDark],
    [3, -10, C.plant],
    [-1, -14, C.plant],
    [5, -4, C.plantDark],
    [-6, -2, C.plant],
  ]) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(p.x + dx, p.y + dy, 5, 3, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function serviceBell(ctx, x, y, z) {
  const p = iso(x, y, z);
  px(ctx, p.x - 3, p.y - 1, '#c9a227', 6, 2);
  px(ctx, p.x - 2, p.y - 4, '#ffd54f', 4, 3);
  px(ctx, p.x, p.y - 5, '#8a6d1a', 1, 1);
}

// ── people ───────────────────────────────────────────────────────────────────────────────────
//
// Character maps. Legend: k outline, h hair, s skin, e eye, m mouth, b shirt, t shirt trim,
// p trousers, o shoes, w white, r red, a apron, g grey, n black. '.' is transparent.

const FRONT = [
  '....kkkkkk....',
  '..kkhhhhhhkk..',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhhk.',
  '.khhsssssshhk.',
  '.kssssssssssk.',
  '.ksseesseessk.',
  '.kssssssssssk.',
  '.ksssssssssk..',
  '..kssmmmmssk..',
  '..kkssssssskk.',
  '...kksssskk...',
  '....kksskk....',
  '...kbbbbbbbk..',
  '..kbbbbbbbbbk.',
  '.kbbbbbbbbbbbk',
  '.kbtbbbbbbbtbk',
  '.kbbbbbbbbbbbk',
  '.ksbbbbbbbbbsk',
  '.kskbbbbbbbksk',
  '..k.kbbbbbbk.k',
  '....kpppppppk.',
  '....kpppppppk.',
  '....kpppkpppk.',
  '....kpppkpppk.',
  '....kpppkpppk.',
  '....koookoook.',
];

const BACK = [
  '....kkkkkk....',
  '..kkhhhhhhkk..',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhhk.',
  '.khhhhhhhhhk..',
  '..khhhhhhhhk..',
  '..kkhhhhhhkk..',
  '...kkssskk....',
  '....kksskk....',
  '...kbbbbbbbk..',
  '..kbbbbbbbbbk.',
  '.kbbbbbbbbbbbk',
  '.kbbbbbbbbbbbk',
  '.kbbbbbbbbbbbk',
  '.ksbbbbbbbbbsk',
  '.kskbbbbbbbksk',
  '..k.kbbbbbbk.k',
  '....kpppppppk.',
  '....kpppppppk.',
  '....kpppkpppk.',
  '....kpppkpppk.',
  '....kpppkpppk.',
  '....koookoook.',
];

const CHEF_HAT = [
  '...kkkkkkkk...',
  '..kwwwwwwwwk..',
  '.kwwwwwwwwwwk.',
  '.kwwwwwwwwwwk.',
  '..kwwwwwwwwk..',
  '..kkkkkkkkkk..',
];

export const FIGURE_H = FRONT.length;
export const FIGURE_W = FRONT[0].length;

const SHIRTS = [
  '#e08a5f',
  '#4fb8aa',
  '#5b8def',
  '#d95c8a',
  '#8bc34a',
  '#f2c14e',
  '#9c6ade',
  '#ef6b6b',
  '#3aa6b9',
  '#c98a3d',
  '#6fcf97',
  '#b0b7c3',
];
const TROUSERS = ['#3a4a6b', '#2e2e38', '#5a4634', '#3b5a4a', '#6b3a4a'];
const HAIRS = ['#2a1d16', '#5a3a22', '#c98a3d', '#e6d3a0', '#1f2430', '#8a2f2f', '#d9d9de'];
const SKINS = ['#f0c9a4', '#e0b48e', '#c48a5a', '#8d5a3a', '#f6dcc2'];
export const HAIR_STYLES = ['short', 'long', 'spiky', 'bun', 'cap', 'bald'];

/** A stable small hash so an agent looks the same every time it walks in. */
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * The outfit for one agent: everything about the figure that is not its status. Derived from
 * the id, so a session keeps its look across restarts; the harness is shown by its logo, not
 * by the shirt, which frees the shirt to be any colour.
 */
export function lookFor(id) {
  const h = hash(id);
  return {
    body: SHIRTS[h % SHIRTS.length],
    trim: shade(SHIRTS[h % SHIRTS.length], -30),
    // Unsigned shifts: `hash` fills all 32 bits, and a signed shift of a high hash lands on a
    // negative index, which is an agent with no trousers.
    pants: TROUSERS[(h >>> 4) % TROUSERS.length],
    hair: HAIRS[(h >>> 8) % HAIRS.length],
    skin: SKINS[(h >>> 12) % SKINS.length],
    style: HAIR_STYLES[(h >>> 16) % HAIR_STYLES.length],
  };
}

function shade(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + delta));
  const r = c(n >> 16);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function palette(look, extra = {}) {
  return {
    k: C.outline,
    h: look.style === 'bald' ? (look.skin ?? C.skin) : look.hair,
    s: look.skin ?? C.skin,
    e: '#1e1a1a',
    m: '#b5654b',
    b: look.body,
    t: look.trim,
    p: look.pants ?? C.pants,
    o: C.shoe,
    w: C.white,
    r: C.red,
    g: C.grey,
    n: C.black,
    c: look.cap ?? '#2f5d8a',
    ...extra,
  };
}

// Hair overlays, as [column, row] offsets from the map's top-left, keyed to the palette.
const HAIR_OVERLAYS = {
  long: {
    key: 'h',
    px: [
      [0, 4],
      [0, 5],
      [0, 6],
      [0, 7],
      [0, 8],
      [0, 9],
      [1, 9],
      [1, 10],
      [13, 4],
      [13, 5],
      [13, 6],
      [13, 7],
      [13, 8],
      [13, 9],
      [12, 9],
      [12, 10],
    ],
  },
  spiky: {
    key: 'h',
    px: [
      [3, -1],
      [6, -2],
      [6, -1],
      [9, -1],
      [4, -1],
      [8, -1],
    ],
  },
  bun: {
    key: 'h',
    px: [
      [5, -2],
      [6, -3],
      [7, -3],
      [8, -2],
      [5, -1],
      [6, -1],
      [7, -1],
      [8, -1],
      [6, -2],
      [7, -2],
    ],
  },
  cap: {
    key: 'c',
    px: [
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
      [10, 1],
      [11, 1],
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 2],
      [7, 2],
      [8, 2],
      [9, 2],
      [10, 2],
      [11, 2],
      [12, 2],
      [1, 3],
      [12, 3],
      [11, 4],
      [12, 4],
      [13, 4],
      [14, 4],
    ],
  },
};

/**
 * A figure standing on tile (x, y), feet at the tile's centre. `facing` is 'front' or 'back';
 * `flip` mirrors it, which gives the four walking directions from two maps. `step` is the
 * walk cycle: 0 standing, 1 and 2 the two stride frames.
 */
export function figure(
  ctx,
  x,
  y,
  pal,
  { facing = 'front', flip = false, step = 0, z = 0, hat = null, style = null } = {},
) {
  const p = iso(x + 0.5, y + 0.5, z);
  const left = p.x - Math.floor(FIGURE_W / 2);
  const top = p.y - FIGURE_H + 2;
  const map = facing === 'back' ? BACK : FRONT;
  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + 1, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (step === 0) {
    blitMap(ctx, map, left, top, pal, flip);
  } else {
    // Stride: the body bobs one pixel, and the legs alternate which is forward.
    const body = map.slice(0, 21);
    const legs = map.slice(21);
    blitMap(ctx, body, left, top - 1, pal, flip);
    const lead = step === 1 ? 0 : 1;
    for (let r = 0; r < legs.length; r++) {
      const row = legs[r];
      const rowLeft = row.slice(0, 8) + '......';
      const rowRight = '........' + row.slice(8);
      blitMap(ctx, [rowLeft], left, top + 21 + r - (lead ? 0 : 1), pal, flip);
      blitMap(ctx, [rowRight], left, top + 21 + r - (lead ? 1 : 0), pal, flip);
    }
  }
  const overlay = style && HAIR_OVERLAYS[style];
  if (overlay && facing === 'front' && step === 0) {
    for (const [c, r] of overlay.px) {
      px(ctx, left + (flip ? FIGURE_W - 1 - c : c), top + r, pal[overlay.key]);
    }
  } else if (overlay && facing === 'front') {
    for (const [c, r] of overlay.px) {
      px(ctx, left + (flip ? FIGURE_W - 1 - c : c), top + r - 1, pal[overlay.key]);
    }
  }
  if (hat === 'chef') blitMap(ctx, CHEF_HAT, left, top - 5, pal, flip);
  return {
    headX: p.x,
    headY: top + 4,
    handX: p.x + (flip ? -8 : 8),
    handY: top + 19,
    feetX: p.x,
    feetY: p.y,
  };
}

export function dinerPalette(id) {
  return palette(lookFor(id));
}

export function chefPalette(id) {
  const look = lookFor(id);
  return palette(look, { b: C.white, t: C.grey, p: '#2f3a4a' });
}

export function waiterPalette(index) {
  const hair = HAIRS[(index * 3 + 1) % HAIRS.length];
  const skin = SKINS[(index * 2) % SKINS.length];
  return palette({ body: C.black, trim: '#3d3d46', hair, skin, pants: '#26262b' });
}

export function hostPalette() {
  return palette({ body: '#6b1f2a', trim: '#4a141c', hair: '#2a1d16', pants: '#26262b' });
}

// ── harness logos ────────────────────────────────────────────────────────────────────────────
//
// Nine-pixel marks. Claude: the orange tile with the white spark. Codex: OpenAI's dark tile
// with the white blossom ring. Small enough to float beside a head, distinct at any zoom.

const CLAUDE_LOGO = [
  '.ooooooo.',
  'ooooooooo',
  'oowoowooo',
  'ooowwwooo',
  'owwwwwwwo',
  'ooowwwooo',
  'oowoowooo',
  'ooooooooo',
  '.ooooooo.',
];
const CODEX_LOGO = [
  '.nnnnnnn.',
  'nnnwwwnnn',
  'nnwnnnwnn',
  'nwnnnnnwn',
  'nwnwnwnwn',
  'nwnnnnnwn',
  'nnwnnnwnn',
  'nnnwwwnnn',
  '.nnnnnnn.',
];
const UNKNOWN_LOGO = [
  '.ggggggg.',
  'ggggggggg',
  'gggwwwggg',
  'ggwgggwgg',
  'gggggwggg',
  'ggggwgggg',
  'ggggggggg',
  'ggggwgggg',
  '.ggggggg.',
];

export function logo(ctx, x, y, flavor) {
  const map = flavor === 'claude' ? CLAUDE_LOGO : flavor === 'codex' ? CODEX_LOGO : UNKNOWN_LOGO;
  blitMap(ctx, map, x, y, { o: '#d97757', w: '#ffffff', n: '#111111', g: '#6b7280' });
}

/** The same marks for the screen-space labels, drawn with plain canvas at any size. */
export function logoVector(ctx, x, y, size, flavor) {
  const r = size * 0.22;
  ctx.save();
  ctx.fillStyle = flavor === 'claude' ? '#d97757' : flavor === 'codex' ? '#111111' : '#6b7280';
  roundRect(ctx, x, y, size, size, r);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  const cx = x + size / 2;
  const cy = y + size / 2;
  if (flavor === 'claude') {
    ctx.lineWidth = Math.max(1.2, size * 0.14);
    ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * size * 0.34, cy - Math.sin(a) * size * 0.34);
      ctx.lineTo(cx + Math.cos(a) * size * 0.34, cy + Math.sin(a) * size * 0.34);
      ctx.stroke();
    }
  } else if (flavor === 'codex') {
    ctx.lineWidth = Math.max(1.2, size * 0.13);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3 - Math.PI / 6;
      const px2 = cx + Math.cos(a) * size * 0.3;
      const py2 = cy + Math.sin(a) * size * 0.3;
      if (i === 0) ctx.moveTo(px2, py2);
      else ctx.lineTo(px2, py2);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.09, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.font = `700 ${Math.round(size * 0.7)}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', cx, cy + 1);
  }
  ctx.restore();
}

/** The waiters' card table: green felt, a hand of cards, chips, and a card turned every so often. */
export function cardTable(ctx, x, y, t) {
  isoBox(ctx, x + 0.42, y + 0.42, 0.16, 0.16, 12, C.woodDark, C.woodDark, C.woodDark);
  const p = iso(x + 0.5, y + 0.5, 12);
  ctx.fillStyle = '#2f6b3e';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, 15, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = C.woodDark;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Cards fanned in the middle; every couple of seconds one is turned face up.
  const turned = Math.floor(t / 2200) % 3;
  for (let i = 0; i < 3; i++) {
    const cx = p.x - 6 + i * 6;
    const cy = p.y - 3 + (i % 2);
    px(ctx, cx, cy - 2, i === turned ? C.white : '#4a6fa5', 4, 5);
    if (i === turned) px(ctx, cx + 1, cy - 1, i % 2 ? C.red : C.black, 2, 2);
  }
  for (const [dx, dy, c] of [
    [-10, 3, '#d9413b'],
    [-8, 4, '#2b7dd6'],
    [9, 2, '#f2c14e'],
    [11, 3, '#d9413b'],
  ]) {
    px(ctx, p.x + dx, p.y + dy, c, 3, 2);
  }
}

/** What a waiter carries: a cloche on a tray on the way out, a note on the way back. */
export function tray(ctx, hx, hy, kind) {
  ctx.fillStyle = C.steel;
  ctx.beginPath();
  ctx.ellipse(hx, hy, 7, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  if (kind === 'report') {
    px(ctx, hx - 3, hy - 6, C.white, 6, 5);
    px(ctx, hx - 2, hy - 5, '#5ee08a', 4, 1);
    px(ctx, hx - 2, hy - 3, '#5ee08a', 3, 1);
  } else {
    ctx.fillStyle = '#e6e9ee';
    ctx.beginPath();
    ctx.ellipse(hx, hy - 3, 6, 4, 0, Math.PI, 0);
    ctx.fill();
    px(ctx, hx - 1, hy - 8, '#ffd166', 2, 2);
  }
}

/** The small status gem over a head — the one Sims idea worth keeping in a Habbo room. */
export function gem(ctx, x, y, color, t, active) {
  const bob = active ? Math.round(Math.sin(t / 380) * 1.5) : 0;
  const yy = y + bob;
  px(ctx, x, yy - 3, color, 1, 1);
  px(ctx, x - 1, yy - 2, color, 3, 1);
  px(ctx, x - 2, yy - 1, color, 5, 1);
  px(ctx, x - 1, yy, color, 3, 1);
  px(ctx, x, yy + 1, color, 1, 1);
  px(ctx, x - 1, yy - 1, 'rgba(255,255,255,0.5)', 1, 1);
}

export function zzz(ctx, x, y, t) {
  for (let i = 0; i < 3; i++) {
    const phase = (t / 1400 + i / 3) % 1;
    ctx.fillStyle = `rgba(210,220,235,${0.9 * (1 - phase)})`;
    const zx = Math.round(x + phase * 7);
    const zy = Math.round(y - phase * 14);
    ctx.fillRect(zx, zy, 3, 1);
    ctx.fillRect(zx + 1, zy + 1, 1, 1);
    ctx.fillRect(zx, zy + 2, 3, 1);
  }
}

export function exclaim(ctx, x, y, t) {
  const on = Math.sin(t / 200) > -0.3;
  if (!on) return;
  px(ctx, x, y - 6, '#ffbf47', 2, 4);
  px(ctx, x, y - 1, '#ffbf47', 2, 2);
}

/** A fork in a hand, rising and falling: the eating animation. */
export function fork(ctx, hx, hy, t) {
  const lift = Math.round(Math.abs(Math.sin(t / 260)) * 6);
  px(ctx, hx, hy - lift, C.grey, 1, 5);
  px(ctx, hx - 1, hy - lift - 2, C.grey, 3, 1);
  px(ctx, hx - 1, hy - lift - 3, C.grey, 1, 1);
  px(ctx, hx + 1, hy - lift - 3, C.grey, 1, 1);
}

/**
 * The Linear key hiding in a workspace name or branch — `pt-559-concurrent-channel-switch`
 * is PT-559 — and the rest of the name as words. Messages are told apart by the key.
 */
export function issueOf(name = '', branch = '') {
  const m =
    /(?:^|[\/\s_-])([A-Za-z]{2,6})-(\d{2,6})(?=$|[\/\s_-])/.exec(name) ??
    /(?:^|[\/\s_-])([A-Za-z]{2,6})-(\d{2,6})(?=$|[\/\s_-])/.exec(branch);
  if (!m) return { key: null, title: name };
  const key = `${m[1].toUpperCase()}-${m[2]}`;
  const title = name
    .replace(new RegExp(`^.*?${m[1]}-${m[2]}[\\s_-]*`, 'i'), '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return { key, title: title || name };
}

/** Agent chrome like `Working · 1h 24m 41s • esc to interrupt` as plain words: `1h 24m`. */
export function plainActivity(activity = '') {
  const long = /(\d+h)?\s*(\d+m)/.exec(activity);
  if (long) return `${long[1] ? `${long[1]} ` : ''}${long[2]}`;
  const secs = /(\d+)s\b/.exec(activity);
  return secs ? `${secs[1]}s` : '';
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = `${last.slice(0, Math.max(0, last.length - 2))}…`;
  }
  return lines;
}
