// The city around the block: the streets and the buildings on every side of the restaurant,
// and the river in front of it — everything on the screen that is not the restaurant or its
// own stretch of pavement.
//
// It is a small city. Two blocks to the left, two to the right, two behind, and then plain
// ground; the camera cannot pull back far enough to see much past that (scene.js keeps it
// inside its opening view), so the town only has to be as big as the window. Blocks are
// generated from their index the first time they are looked at and kept.
//
// Nothing out here is walkable and nothing is an agent. It is scenery, and its one job is to
// make the restaurant stand in a city.

import { TILE_H, iso, isoBox, px, hash } from './draw.js';
import { S, tint, faceQuad, awning, streetProp, backRailing } from './street.js';
import { CITY } from './district.js';

const YARD = '#3a4148';
const YARD_LINE = '#333a42';
const WATER = '#141d29';
const QUAY_H = 12;

// ── screen geometry ──────────────────────────────────────────────────────────────────────────

/** The screen height, in world units, of the point on tile row `y` at world x `sx`. */
const rowLineY = (sx, y) => sx / 2 + TILE_H * y;
/** The same for tile column `x`: the other diagonal. */
const colLineY = (sx, x) => -sx / 2 + TILE_H * x;

/** The range of tile coordinates a view (a world-unit rectangle) can see. */
function tileBounds(view) {
  const xs = [];
  const ys = [];
  for (const [sx, sy] of [
    [view.x0, view.y0],
    [view.x1, view.y0],
    [view.x0, view.y1],
    [view.x1, view.y1],
  ]) {
    xs.push((sy + sx / 2) / TILE_H);
    ys.push((sy - sx / 2) / TILE_H);
  }
  return {
    xmin: Math.floor(Math.min(...xs)) - 1,
    xmax: Math.ceil(Math.max(...xs)) + 1,
    ymin: Math.floor(Math.min(...ys)) - 1,
    ymax: Math.ceil(Math.max(...ys)) + 1,
  };
}

/** A small deterministic generator, so a block looks the same every time it is looked at. */
function lcg(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const mod = (n, m) => ((n % m) + m) % m;

// ── the ground ───────────────────────────────────────────────────────────────────────────────

/**
 * Everything at ground level that is not the district's own tiles: the ground itself, the
 * streets and pavements of the grid, and the river. Drawn in world space; the district's own
 * tiles go on top of this.
 */
export function drawCityGround(ctx, district, view, t) {
  const { city, street } = district;
  const a = view.x0 - 4;
  const b = view.x1 + 4;
  const tiles = tileBounds(view);

  ctx.fillStyle = YARD;
  ctx.fillRect(a, view.y0 - 4, b - a, view.y1 - view.y0 + 8);

  // ── pavements: two tiles either side of every street ────────────────────────────────────
  const rowRoads = cityRowRoads(district, tiles);
  const colRoads = cityColRoads(district);
  ctx.fillStyle = S.slab;
  for (const road of rowRoads) {
    if (road.main) rowBandPath(ctx, road.y0 - CITY.pave, road.y1 + CITY.pave, a, b);
    else tileRectPath(ctx, city.x0, road.y0 - CITY.pave, city.x1, road.y1 + CITY.pave);
    ctx.fill();
  }
  for (const road of colRoads) {
    tileRectPath(ctx, road.x0 - CITY.pave, city.y0, road.x1 + CITY.pave, city.sideRoadEnd);
    ctx.fill();
  }

  // ── the joints between the slabs: the tile grid, fading out as the camera pulls back ─────
  const gridAlpha = Math.min(1, Math.max(0, (view.zoom - 0.45) / 0.6));
  if (gridAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = gridAlpha;
    ctx.strokeStyle = YARD_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const j0 = Math.ceil((view.y0 - b / 2) / TILE_H);
    const j1 = Math.floor((view.y1 - a / 2) / TILE_H);
    for (let j = j0; j <= j1; j++) {
      ctx.moveTo(a, rowLineY(a, j));
      ctx.lineTo(b, rowLineY(b, j));
    }
    const i0 = Math.ceil((view.y0 + a / 2) / TILE_H);
    const i1 = Math.floor((view.y1 + b / 2) / TILE_H);
    for (let i = i0; i <= i1; i++) {
      ctx.moveTo(a, colLineY(a, i));
      ctx.lineTo(b, colLineY(b, i));
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── the streets ─────────────────────────────────────────────────────────────────────────
  ctx.fillStyle = S.asphalt;
  for (const road of rowRoads) {
    if (road.main) rowBandPath(ctx, road.y0, road.y1, a, b);
    else tileRectPath(ctx, city.x0, road.y0, city.x1, road.y1);
    ctx.fill();
  }
  for (const road of colRoads) {
    tileRectPath(ctx, road.x0, city.y0, road.x1, city.sideRoadEnd);
    ctx.fill();
  }

  // Kerbs run along the blocks and stop at every junction.
  ctx.strokeStyle = S.kerbTop;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const colBands = cityColBands(district);
  const rowBands = cityRowBands(district);
  for (const road of rowRoads) {
    for (const band of colBands) {
      const x0 = band.x0 - CITY.pave;
      const x1 = band.x1 + CITY.pave;
      for (const y of [road.y0, road.y1]) {
        // The main road's near kerb has no junctions: nothing comes down to the river.
        if (road.main && y === road.y1) continue;
        const p = iso(x0, y);
        const q = iso(x1, y);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
    }
    if (road.main) {
      // Beyond the town the main road runs on between plain kerbs.
      for (const [x0, x1] of [
        [tiles.xmin, city.x0 - CITY.pave],
        [city.x1 + CITY.pave, tiles.xmax],
      ]) {
        if (x1 <= x0) continue;
        const p = iso(x0, road.y0);
        const q = iso(x1, road.y0);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      const p = iso(tiles.xmin, street.roadY + street.roadRows);
      const q = iso(tiles.xmax, street.roadY + street.roadRows);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
  }
  for (const road of colRoads) {
    for (const band of rowBands) {
      const y0 = Math.max(band.y0 - CITY.pave, city.y0);
      const y1 = Math.min(band.y1 + CITY.pave, city.sideRoadEnd);
      if (y1 <= y0) continue;
      for (const x of [road.x0, road.x1]) {
        const p = iso(x, y0);
        const q = iso(x, y1);
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
    }
  }
  ctx.stroke();

  // Centre lines, broken at every junction.
  ctx.fillStyle = S.lane;
  ctx.beginPath();
  for (const road of rowRoads) {
    const mid = road.y0 + (road.y1 - road.y0) / 2 - 0.5;
    const x0 = road.main ? tiles.xmin : city.x0;
    const x1 = road.main ? tiles.xmax : city.x1;
    for (let x = Math.floor(x0 / 2) * 2 + 0.4; x < x1; x += 2) {
      if (city.isRoadColumn(Math.floor(x)) && !road.main) continue;
      const p = iso(x, mid);
      ctx.moveTo(p.x, p.y - 1);
      ctx.lineTo(p.x + 14, p.y + 6);
      ctx.lineTo(p.x + 14, p.y + 8);
      ctx.lineTo(p.x, p.y + 1);
      ctx.closePath();
    }
  }
  for (const road of colRoads) {
    const mid = road.x0 + (road.x1 - road.x0) / 2 - 0.5;
    for (let y = Math.floor(city.y0 / 2) * 2 + 0.4; y < city.sideRoadEnd - 1; y += 2) {
      if (y < city.y0 || city.isRoadRow(Math.floor(y))) continue;
      const p = iso(mid, y);
      ctx.moveTo(p.x, p.y - 1);
      ctx.lineTo(p.x - 14, p.y + 6);
      ctx.lineTo(p.x - 14, p.y + 8);
      ctx.lineTo(p.x, p.y + 1);
      ctx.closePath();
    }
  }
  ctx.fill();

  drawRiver(ctx, district, view, a, b, t);
}

/** The region between two tile rows, across the whole visible width. */
function rowBandPath(ctx, y0, y1, a, b) {
  ctx.beginPath();
  ctx.moveTo(a, rowLineY(a, y0));
  ctx.lineTo(b, rowLineY(b, y0));
  ctx.lineTo(b, rowLineY(b, y1));
  ctx.lineTo(a, rowLineY(a, y1));
  ctx.closePath();
}

/** A rectangle of tiles, as the diamond it is on screen. */
function tileRectPath(ctx, x0, y0, x1, y1) {
  const p = iso(x0, y0);
  const q = iso(x1, y0);
  const r = iso(x1, y1);
  const s = iso(x0, y1);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(q.x, q.y);
  ctx.lineTo(r.x, r.y);
  ctx.lineTo(s.x, s.y);
  ctx.closePath();
}

/** The streets that run across: the main road, and one behind each ring of blocks. */
function cityRowRoads(district, tiles) {
  const { city, street } = district;
  const roads = [];
  if (street.roadY <= tiles.ymax && street.roadY + street.roadRows >= tiles.ymin) {
    roads.push({ y0: street.roadY, y1: street.roadY + street.roadRows, main: true });
  }
  for (let j = 0; j < city.ring.back; j++) roads.push({ ...city.rowRoad(j), j });
  return roads;
}

/** The streets that run away from the river, between and outside the columns of blocks. */
function cityColRoads(district) {
  const { city } = district;
  const roads = [];
  for (let i = -city.ring.side - 1; i <= city.ring.side; i++) {
    roads.push({ ...city.colRoad(i), i });
  }
  return roads;
}

function cityColBands(district) {
  const { city } = district;
  const bands = [];
  for (let i = -city.ring.side; i <= city.ring.side; i++) bands.push({ ...city.colBand(i), i });
  return bands;
}

function cityRowBands(district) {
  const { city } = district;
  const bands = [];
  for (let j = 0; j <= city.ring.back; j++) bands.push({ ...city.rowBand(j), j });
  return bands;
}

/**
 * The river along the front of the block, a quay's height below the pavement. The city's glow
 * lies on the water nearest the quay and the rest is dark; the ripples are the only thing on
 * the whole screen that moves for no reason.
 */
function drawRiver(ctx, district, view, a, b, t) {
  const { d } = district;
  const edge = (sx) => rowLineY(sx, d);
  if (edge(a) > view.y1 + 40 && edge(b) > view.y1 + 40) return;
  // The quay wall, seen face-on.
  ctx.fillStyle = '#3f4652';
  ctx.beginPath();
  ctx.moveTo(a, edge(a));
  ctx.lineTo(b, edge(b));
  ctx.lineTo(b, edge(b) + QUAY_H);
  ctx.lineTo(a, edge(a) + QUAY_H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2c323c';
  ctx.beginPath();
  ctx.moveTo(a, edge(a) + QUAY_H - 3);
  ctx.lineTo(b, edge(b) + QUAY_H - 3);
  ctx.lineTo(b, edge(b) + QUAY_H);
  ctx.lineTo(a, edge(a) + QUAY_H);
  ctx.closePath();
  ctx.fill();

  // The water: a half-plane, lit along the quay.
  const mx = (a + b) / 2;
  const my = edge(mx) + QUAY_H;
  const g = ctx.createLinearGradient(mx, my, mx - 0.447 * 320, my + 0.894 * 320);
  g.addColorStop(0, '#26384c');
  g.addColorStop(0.35, '#1a2736');
  g.addColorStop(1, WATER);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(a, edge(a) + QUAY_H);
  ctx.lineTo(b, edge(b) + QUAY_H);
  ctx.lineTo(b, view.y1 + 4000);
  ctx.lineTo(a, view.y1 + 4000);
  ctx.closePath();
  ctx.fill();

  // Ripples, on a coarse grid, drifting a few pixels.
  const cell = 40;
  const cx0 = Math.floor(a / cell);
  const cx1 = Math.floor(b / cell);
  const cy0 = Math.floor(Math.max(view.y0, edge(a)) / cell);
  const cy1 = Math.floor(view.y1 / cell);
  if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 5000) return;
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      const h = hash(`w${cx},${cy}`);
      if (h % 100 >= 45) continue;
      const wx = cx * cell + ((h >>> 8) % cell);
      const wy = cy * cell + ((h >>> 16) % cell);
      if (wy < edge(wx) + QUAY_H + 4) continue;
      const near = Math.max(0, 1 - (wy - edge(wx)) / 260);
      const drift = Math.sin(t / 1600 + (h % 17)) * 3;
      const bright = 0.18 + near * 0.35 + 0.15 * Math.sin(t / 900 + h);
      ctx.globalAlpha = Math.max(0.08, bright);
      px(ctx, wx + drift, wy, '#6d87a6', 5 + (h % 4), 1);
    }
  }
  ctx.globalAlpha = 1;
}

// ── the blocks ───────────────────────────────────────────────────────────────────────────────

const SKINS = [
  '#6e4b3d', // brick
  '#5d6573', // slate
  '#8b7b5f', // sandstone
  '#4e5c6d', // steel
  '#7b5b4f', // terracotta
  '#5a5e6a', // concrete
  '#3d4a5a', // glass
  '#6a5b6b', // mauve
  '#7a6a55', // stucco
];

const AWNINGS = [
  ['#8f2b2b', '#f4ede0'],
  ['#2b5a8f', '#f4ede0'],
  ['#2f6b3e', '#f4ede0'],
  ['#8a6a2a', '#f4ede0'],
];

const blocks = new Map();

/** The block at grid index (i, j), generated the first time it is asked for. */
function blockAt(district, i, j) {
  if (i === 0 && j === 0) return null; // the restaurant's own block
  const { city } = district;
  if (Math.abs(i) > city.ring.side || j < 0 || j > city.ring.back) return null;
  const key = `${i},${j}`;
  let block = blocks.get(key);
  if (block && block.hw === district.house.w && block.rd === district.houseDepth) return block;
  const rect = { ...city.colBand(i), ...city.rowBand(j) };
  const buildings = lotsOf(rect, hash(`block${key}`)).map((lot) => makeBuilding(lot, key));
  block = { i, j, rect, buildings, hw: district.house.w, rd: district.houseDepth };
  blocks.set(key, block);
  return block;
}

/** Cut a block into lots: a row or two of them, with the odd alley between. */
function lotsOf(rect, seed) {
  const rnd = lcg(seed);
  const W = rect.x1 - rect.x0;
  const D = rect.y1 - rect.y0;
  const lots = [];
  const cols = Math.max(1, Math.round(W / (4 + rnd() * 3)));
  const rows = D >= 12 ? 2 : 1;
  const widths = share(W, cols, rnd);
  const depths = rows === 2 ? share(D, 2, rnd) : [D];
  let y = rect.y0;
  for (const depth of depths) {
    let x = rect.x0;
    for (const width of widths) {
      const gapR = width > 4 && rnd() < 0.45 ? 1 : 0;
      const gapB = depth > 4 && rnd() < 0.5 ? 1 : 0;
      const w = width - gapR;
      const d = depth - gapB;
      if (w >= 2 && d >= 2) lots.push({ x, y, w, d, rnd: lcg(Math.floor(rnd() * 1e9)) });
      x += width;
    }
    y += depth;
  }
  return lots;
}

function share(total, parts, rnd) {
  const out = [];
  let left = total;
  for (let i = parts; i > 0; i--) {
    const even = left / i;
    const v = i === 1 ? left : Math.max(2, Math.round(even * (0.75 + rnd() * 0.5)));
    out.push(Math.min(v, left - 2 * (i - 1)));
    left -= out[out.length - 1];
  }
  return out;
}

/** One building on a lot, with everything that will not change from frame to frame prebuilt. */
function makeBuilding(lot, blockKey) {
  const { x, y, w, d, rnd } = lot;
  const tall = rnd() < 0.16;
  const h = Math.round(34 + rnd() * 70 + (tall ? 60 + rnd() * 90 : 0));
  const base = SKINS[Math.floor(rnd() * SKINS.length)];
  const glass = base === '#3d4a5a';
  const warm = rnd() < 0.7;
  const glow = warm ? '#f2d38a' : '#b9d7f5';
  const lit = new Path2D();
  const dark = new Path2D();
  const flicker = [];
  const yF = y + d;
  const xF = x + w;
  const ground = 15;
  const addWindow = (a, b, v0, v1) => {
    const on = rnd() < (glass ? 0.6 : 0.42);
    const path = on ? lit : dark;
    path.moveTo(a.x, a.y - v0);
    path.lineTo(b.x, b.y - v0);
    path.lineTo(b.x, b.y - v1);
    path.lineTo(a.x, a.y - v1);
    path.closePath();
    if (on && rnd() < 0.05) {
      flicker.push({ a, b, v0, v1, period: 1500 + rnd() * 3000, phase: rnd() * 7 });
    }
  };
  for (let v = ground + 5; v + 7 < h - 5; v += 11) {
    for (let u = 0.2; u + 0.3 < w; u += 0.5) {
      addWindow(iso(x + u, yF), iso(x + u + 0.28, yF), v, v + 7);
    }
    for (let u = 0.2; u + 0.3 < d; u += 0.5) {
      addWindow(iso(xF, y + u), iso(xF, y + u + 0.28), v, v + 7);
    }
  }
  const shop = !glass && rnd() < 0.45;
  return {
    x,
    y,
    w,
    d,
    h,
    key: x + w + y + d,
    top: tint(base, 22),
    left: base,
    right: tint(base, -26),
    plinth: tint(base, -18),
    roof: tint(base, 6),
    glow,
    lit,
    dark,
    flicker,
    shop,
    awning: AWNINGS[Math.floor(rnd() * AWNINGS.length)],
    tank: h > 70 && rnd() < 0.4,
    tankAt: [0.25 + rnd() * 0.4, 0.25 + rnd() * 0.4],
    units: rnd() < 0.5,
    antenna: h > 120 && rnd() < 0.7,
    id: `${blockKey}:${x},${y}`,
    // The screen box, for culling.
    minX: iso(x, yF).x - 2,
    maxX: iso(xF, y).x + 2,
    minY: iso(x, y).y - h - 44,
    maxY: iso(xF, yF).y + 2,
  };
}

function drawBuilding(ctx, bld, t) {
  const { x, y, w, d, h } = bld;
  isoBox(ctx, x, y, w, d, h, bld.top, bld.right, bld.left);
  // The ground floor: a darker plinth, with a shop lit on the front of some of them.
  faceQuad(ctx, x, y + d, 0, w, 0, 15, bld.plinth);
  sideQuad(ctx, x + w, y, 0, d, 0, 15, tint(bld.plinth, -12));
  if (bld.shop) {
    faceQuad(ctx, x, y + d, 0.2, w - 0.2, 2, 12, 'rgba(244,213,138,0.85)');
    faceQuad(ctx, x, y + d, 0.2, w - 0.2, 2, 4.5, 'rgba(0,0,0,0.3)');
    awning(ctx, x + 0.1, y + d, w - 0.2, 15, 0.42, bld.awning[0], bld.awning[1], 3);
  } else {
    faceQuad(ctx, x, y + d, 0.4, 0.9, 1, 11, '#1b1f27');
  }
  ctx.fillStyle = bld.glow;
  ctx.fill(bld.lit);
  ctx.fillStyle = 'rgba(12,16,24,0.55)';
  ctx.fill(bld.dark);
  for (const f of bld.flicker) {
    if (Math.sin(t / f.period + f.phase) > 0.2) continue;
    ctx.fillStyle = 'rgba(12,16,24,0.7)';
    ctx.beginPath();
    ctx.moveTo(f.a.x, f.a.y - f.v0);
    ctx.lineTo(f.b.x, f.b.y - f.v0);
    ctx.lineTo(f.b.x, f.b.y - f.v1);
    ctx.lineTo(f.a.x, f.a.y - f.v1);
    ctx.closePath();
    ctx.fill();
  }
  // The roof: a parapet round a flat top, and whatever stands on it.
  const inset = 0.3;
  const a = iso(x + inset, y + inset, h);
  const b = iso(x + w - inset, y + inset, h);
  const c = iso(x + w - inset, y + d - inset, h);
  const e = iso(x + inset, y + d - inset, h);
  ctx.fillStyle = bld.roof;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(e.x, e.y);
  ctx.closePath();
  ctx.fill();
  if (bld.tank) {
    const tx = x + bld.tankAt[0] * w;
    const ty = y + bld.tankAt[1] * d;
    isoBox(ctx, tx, ty, 0.7, 0.7, 11, '#5a4a3c', '#2f2620', '#3f342b', h);
    const p = iso(tx + 0.35, ty + 0.35, h + 11);
    px(ctx, p.x - 5, p.y - 3, '#6b5a4a', 10, 2);
  }
  if (bld.units) {
    isoBox(ctx, x + w - 1.2, y + 0.4, 0.5, 0.5, 4, '#8f98a5', '#5a6270', '#737c89', h);
    isoBox(ctx, x + w - 1.9, y + 0.4, 0.5, 0.5, 4, '#8f98a5', '#5a6270', '#737c89', h);
  }
  if (bld.antenna) {
    const p = iso(x + w * 0.7, y + d * 0.4, h);
    px(ctx, p.x, p.y - 22, '#2a2f38', 1, 22);
    if (Math.sin(t / 800 + x) > 0.5) px(ctx, p.x - 1, p.y - 24, '#ff5a4a', 3, 3);
  }
}

/** A quad on the face that looks down-right (the +x face), in the same terms as faceQuad. */
function sideQuad(ctx, xFront, y, u0, u1, v0, v1, fill) {
  const a = iso(xFront, y + u0);
  const b = iso(xFront, y + u1);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - v0);
  ctx.lineTo(b.x, b.y - v0);
  ctx.lineTo(b.x, b.y - v1);
  ctx.lineTo(a.x, a.y - v1);
  ctx.closePath();
  ctx.fill();
}

/**
 * Where a lamp on a pavement sorts against the buildings beside it. A thing on the pavement
 * in front of a building's visible face has to be drawn after that building however its tile
 * sums; a thing behind it, before. Depth alone cannot say both, so the neighbours are asked.
 */
function propKey(x, y, buildings) {
  let key = x + y + 1;
  for (const b of buildings) {
    const frontOfRight = x >= b.x + b.w && y >= b.y && y < b.y + b.d;
    const frontOfFront = y >= b.y + b.d && x >= b.x && x < b.x + b.w;
    if (frontOfRight || frontOfFront) key = Math.max(key, b.key + 0.5);
  }
  return key;
}

/**
 * Everything standing in the city that is in view, as painter items sorted back to front:
 * the buildings, and the lamps and trees on the streets between them. All of it is drawn
 * before the restaurant, which is right for everything beside or behind it; what is in front
 * of it is on the main road, and that comes from cityStreetProps instead.
 */
export function cityObjects(ctx, district, view, t) {
  const { city } = district;
  const items = [];
  const seen = new Set();
  const colBands = cityColBands(district);
  const rowBands = cityRowBands(district);

  for (const cb of colBands) {
    for (const rb of rowBands) {
      const block = blockAt(district, cb.i, rb.j);
      if (!block) continue;
      for (const b of block.buildings) {
        if (b.maxX < view.x0 || b.minX > view.x1 || b.maxY < view.y0 || b.minY > view.y1) continue;
        items.push({ depth: b.key, draw: () => drawBuilding(ctx, b, t) });
      }
    }
  }

  // Lamps and trees along the side streets, at the kerb and against the buildings.
  const propAt = (kind, x, y, buildings) => {
    const k = `${x},${y}`;
    if (seen.has(k)) return;
    seen.add(k);
    const p = iso(x + 0.5, y + 0.5);
    if (p.x < view.x0 - 40 || p.x > view.x1 + 40 || p.y < view.y0 - 20 || p.y > view.y1 + 80)
      return;
    items.push({ depth: propKey(x, y, buildings), draw: () => streetProp(ctx, { kind, x, y }, t) });
  };
  for (let i = -city.ring.side - 1; i <= city.ring.side; i++) {
    const road = city.colRoad(i);
    for (const rb of rowBands) {
      const left = blockAt(district, i, rb.j)?.buildings ?? [];
      const right = blockAt(district, i + 1, rb.j)?.buildings ?? [];
      const y0 = Math.max(city.y0, rb.y0 - CITY.pave);
      const y1 = Math.min(city.sideRoadEnd - 1, rb.y1 + CITY.pave - 1);
      for (let y = y0; y <= y1; y++) {
        if (city.isRoadRow(y)) continue;
        // The restaurant's own right-hand wall end: nothing tall against it.
        if (i === 0 && rb.j === 0 && y < 4) continue;
        if (mod(y, 8) === 4) {
          propAt('lamp', road.x0 - 1, y, left);
          propAt('lamp', road.x1, y, right);
        }
        if (mod(y, 9) === 0) {
          propAt('tree', road.x0 - 2, y, left);
          propAt('tree', road.x1 + 1, y, right);
        }
        if (mod(y, 13) === 7) propAt('bin', road.x1, y, right);
      }
    }
  }
  // And along the streets behind, where the pavement runs the other way.
  for (const rb of rowBands) {
    if (rb.j === 0) continue;
    const road = city.rowRoad(rb.j - 1); // the street in front of this band
    for (const cb of colBands) {
      const behind = blockAt(district, cb.i, rb.j)?.buildings ?? [];
      const ahead = blockAt(district, cb.i, rb.j - 1)?.buildings ?? [];
      const x0 = Math.max(city.x0, cb.x0 - CITY.pave);
      const x1 = Math.min(city.x1 - 1, cb.x1 + CITY.pave - 1);
      for (let x = x0; x <= x1; x++) {
        if (city.isRoadColumn(x)) continue;
        if (mod(x, 8) === 4) {
          propAt('lamp', x, road.y0 - 1, ahead);
          propAt('lamp', x, road.y1, behind);
        }
        if (mod(x, 9) === 2) {
          propAt('tree', x, road.y0 - 2, ahead);
          propAt('tree', x, road.y1 + 1, behind);
        }
        if (mod(x, 11) === 6) propAt('bench', x, road.y1 + 1, behind);
      }
    }
  }

  items.sort((p, q) => p.depth - q.depth);
  return items;
}

/**
 * The main road's pavements beyond the district's own stretch of them: the same lamps, bins,
 * benches and trees at the same pitches, and cars parked along the kerb. These are in front
 * of the restaurant, so the scene sorts them in with its own street.
 */
export function cityStreetProps(district, view) {
  const { street, city, w } = district;
  const tiles = tileBounds(view);
  const { walkY, roadY, roadRows, kerbY, crowdY, crowdRows } = street;
  const backEdge = crowdY + crowdRows - 1;
  const props = [];
  if (walkY > tiles.ymax || backEdge < tiles.ymin) return props;
  for (let x = Math.max(tiles.xmin, city.x0); x <= Math.min(tiles.xmax, city.x1 - 1); x++) {
    if (x >= 0 && x < w) continue;
    const onRoad = city.isRoadColumn(x);
    if (!onRoad) {
      if (mod(x, 8) === 4) props.push({ kind: 'lamp', x, y: walkY + 1 });
      if (mod(x, 10) === 3) props.push({ kind: 'bin', x, y: walkY + 1 });
      if (mod(x, 11) === 7) props.push({ kind: 'bench', x, y: walkY });
      if (mod(x, 9) === 2) props.push({ kind: 'tree', x, y: walkY });
    }
    if (mod(x, 11) === 6) props.push({ kind: 'bin', x, y: kerbY + 1 });
    if (mod(x, 12) === 9) props.push({ kind: 'bollard', x, y: crowdY });
    if (mod(x, 9) === 1) props.push({ kind: 'lamp', x, y: backEdge });
    if (mod(x, 13) === 6) props.push({ kind: 'bench', x, y: backEdge });
    if (mod(x, 11) === 4) props.push({ kind: 'tree', x, y: backEdge });
    if (mod(x, 14) === 5) {
      props.push({ kind: 'parked', x, y: roadY + roadRows - 1.15, index: mod(x, 7) });
    }
  }
  return props;
}

/** The quay: its railing along the whole visible waterfront, and the boats tied up at it. */
export function drawQuay(ctx, district, view, t) {
  const { d } = district;
  const tiles = tileBounds(view);
  if (rowLineY(view.x0, d) > view.y1 + 40 && rowLineY(view.x1, d) > view.y1 + 40) return;
  backRailing(ctx, tiles.xmin, tiles.xmax, d);
  for (let x = Math.floor(tiles.xmin / 41) * 41; x <= tiles.xmax; x += 41) {
    const bx = x + 13;
    if (bx + 3 < tiles.xmin || bx > tiles.xmax) continue;
    boat(ctx, bx, d + 0.9, t);
  }
}

/** A small boat moored at the quay, riding the water. */
function boat(ctx, x, y, t) {
  const bob = Math.sin(t / 1300 + x) * 1.2;
  const z = -QUAY_H + 2 + bob;
  isoBox(ctx, x, y, 2.4, 0.9, 6, '#7d5a3a', '#3d2a18', '#5a3f26', z);
  isoBox(ctx, x + 0.5, y + 0.2, 1.1, 0.5, 8, '#e8e4d8', '#8a877c', '#bdb9ad', z + 6);
  const p = iso(x + 1.9, y + 0.45, z + 6);
  px(ctx, p.x, p.y - 26, '#3a2a22', 1, 26);
  if (Math.sin(t / 900 + x) > -0.6) px(ctx, p.x - 1, p.y - 28, '#ffe9a8', 3, 3);
  const q = iso(x + 1.2, y + 0.45, z + 6);
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath();
  ctx.ellipse(q.x, q.y + 18, 18, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
