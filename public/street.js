// The street outside the restaurant: the road, the block next door, and the food carts.
//
// Same rules as the room in draw.js — whole-pixel shapes in world units, three shades to a
// solid, drawn onto a canvas the scene has already scaled. The one thing this file does that
// the room does not is write on walls: a sign is painted onto the face it belongs to with a
// shear, so it lies down flat in the isometry instead of floating in front of it.

import { TILE_W, TILE_H, iso, isoBox, px, C } from './draw.js';
import { KITCHEN_ROWS, COUNTER_Y, STOOL_X, FLOOR_X, HOUSE_WALL_H } from './district.js';
import { sky } from './daylight.js';

export const S = {
  asphalt: '#2b2f38',
  asphaltAlt: '#282c34',
  asphaltLine: '#333844',
  lane: '#c7b45e',
  kerb: '#7d8492',
  kerbTop: '#9aa2b0',
  slab: '#565f6d',
  slabAlt: '#515a68',
  slabLine: '#454d59',
  metal: '#8f98a5',
  metalDark: '#5a6270',
};

/** Building palettes, indexed by a plan's `style`. */
export function tint(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + delta));
  return `#${((c(n >> 16) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, '0')}`;
}

/**
 * A quad on the face that looks down-left (toward the pavement), given in face coordinates:
 * `u` runs along +x in tiles from the face's left corner, `v` runs straight up in pixels.
 */
export function faceQuad(ctx, x, yFront, u0, u1, v0, v1, fill) {
  const a = iso(x + u0, yFront);
  const b = iso(x + u1, yFront);
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
 * Run a drawing in the face's own frame: the origin sits at (u, v) on the face and one local
 * pixel to the right is one pixel along the face, which in the isometry means one right and a
 * half down. Text and emblems drawn in here lie on the wall.
 */
function onFace(ctx, x, yFront, u, v, draw) {
  const a = iso(x + u, yFront);
  ctx.save();
  ctx.transform(1, 0.5, 0, 1, a.x, a.y - v);
  draw(ctx);
  ctx.restore();
}

// ── the ground ───────────────────────────────────────────────────────────────────────────────

/**
 * The ground, as a handful of paths.
 *
 * There are around sixteen hundred tiles in a district of any size, and every one of them is
 * identical from frame to frame. Drawing them individually was most of a frame's work for a
 * picture that never changes, so the tiles are sorted into one path per colour when the
 * district is built and a frame becomes a dozen fills. Still vector, so still crisp at any
 * zoom — which is the whole reason the scene draws rather than blits.
 */
export function buildGround(district) {
  const { w, d, house, street, houseDepth } = district;
  const roadEnd = street.roadY + street.roadRows;
  const layers = [];
  const byKey = new Map();
  const tile = (key, fill, stroke, x, y) => {
    let layer = byKey.get(key);
    if (!layer) {
      layer = { fill, stroke, path: new Path2D() };
      byKey.set(key, layer);
      layers.push(layer);
    }
    const p = iso(x, y);
    layer.path.moveTo(p.x, p.y);
    layer.path.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2);
    layer.path.lineTo(p.x, p.y + TILE_H);
    layer.path.lineTo(p.x - TILE_W / 2, p.y + TILE_H / 2);
    layer.path.closePath();
  };

  const inside = (x) => x >= house.ox && x < house.ox + house.w;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < d; y++) {
      const even = (x + y) % 2 === 0;
      if (y < houseDepth) {
        // Outside the frontage there is nothing behind it to stand on, and drawing ground
        // there would only make the night look like a floor.
        if (!inside(x)) continue;
        const bar = house.bar;
        const onLeg = x - house.ox <= STOOL_X && y <= bar.y0 + bar.len - 1;
        const onArm = y <= STOOL_X - 1 && x <= bar.armTo;
        if (onLeg || onArm) {
          // Dark slate under the whole L, so the mahogany standing on it reads at any zoom.
          tile(`b${even}`, even ? '#2c3138' : '#282d34', '#20242a', x, y);
        } else if (x - house.ox >= FLOOR_X && y <= COUNTER_Y && y < KITCHEN_ROWS + 1) {
          tile(`k${even}`, even ? C.kitchenA : C.kitchenB, '#b9c3cc', x, y);
        } else if (y > house.lobbyY) {
          tile(`l${even}`, even ? '#6b3f4a' : '#623943', '#4f2e37', x, y);
        } else {
          tile(`f${even}`, even ? C.floorA : C.floorB, C.floorLine, x, y);
        }
        continue;
      }
      if (y >= street.roadY && y < roadEnd) {
        tile(`r${even}`, even ? S.asphalt : S.asphaltAlt, S.asphaltLine, x, y);
      } else if (y < street.roadY && !inside(x) && district.city.isRoadColumn(x)) {
        // A side street comes down through the far pavement to meet the road; the city draws
        // the asphalt there, so the pavement must not.
        continue;
      } else {
        tile(`p${even}`, even ? S.slab : S.slabAlt, S.slabLine, x, y);
      }
    }
  }

  // The markings are as static as the tarmac they are painted on.
  const band = (fill, quads) => {
    const path = new Path2D();
    for (const [ax, ay, bx, by, cx, cy, dx2, dy2] of quads) {
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
      path.lineTo(cx, cy);
      path.lineTo(dx2, dy2);
      path.closePath();
    }
    layers.push({ fill, stroke: null, path });
  };

  const kerbTop = [];
  const kerbFace = [];
  const kerb = (x0, x1, y) => {
    const a = iso(x0, y);
    const b = iso(x1, y);
    kerbTop.push([a.x, a.y, b.x, b.y, b.x, b.y - 2, a.x, a.y - 2]);
    kerbFace.push([a.x, a.y, b.x, b.y, b.x, b.y + 2, a.x, a.y + 2]);
  };
  kerb(0, w, roadEnd);
  // The far kerb is dropped wherever a side street meets the road.
  let from = 0;
  for (let x = 0; x <= w; x++) {
    const onRoad = x < w && !inside(x) && district.city.isRoadColumn(x);
    if (onRoad) {
      if (x > from) kerb(from, x, street.roadY);
      from = x + 1;
    }
  }
  if (w > from) kerb(from, w, street.roadY);
  band(S.kerbTop, kerbTop);
  band(S.kerb, kerbFace);

  const dashes = [];
  const mid = street.roadY + 1;
  for (let x = 0.4; x < w - 0.6; x += 2) {
    const p = iso(x, mid);
    dashes.push([p.x, p.y - 1, p.x + 14, p.y + 6, p.x + 14, p.y + 8, p.x, p.y + 1]);
  }
  band(S.lane, dashes);

  const zebra = [];
  for (const crossing of street.crossings) {
    for (let x = crossing.x0; x <= crossing.x1; x++) {
      const a = iso(x + 0.18, street.roadY);
      const b = iso(x + 0.72, street.roadY);
      const c = iso(x + 0.72, roadEnd);
      const e = iso(x + 0.18, roadEnd);
      zebra.push([a.x, a.y, b.x, b.y, c.x, c.y, e.x, e.y]);
    }
  }
  band('rgba(236,241,248,0.78)', zebra);

  return layers;
}

export function drawGround(ctx, layers) {
  ctx.lineWidth = 1;
  for (const layer of layers) {
    ctx.fillStyle = layer.fill;
    ctx.fill(layer.path);
    if (!layer.stroke) continue;
    ctx.strokeStyle = layer.stroke;
    ctx.stroke(layer.path);
  }
}

// ── the block next door ──────────────────────────────────────────────────────────────────────

/**
 * A striped canopy hanging off a face. `depth` is how far it reaches over the pavement and
 * `drop` how far its outer lip hangs below where it is fixed — between them they decide what
 * the canopy covers, which for a serving hatch is the difference between shade and a lid.
 */
export function awning(ctx, x, yF, width, v, depth, colorA, colorB, drop = 7) {
  const steps = Math.max(4, Math.round(width / 0.22));
  for (let i = 0; i < steps; i++) {
    const u0 = (i / steps) * width;
    const u1 = ((i + 1) / steps) * width;
    const a = iso(x + u0, yF);
    const b = iso(x + u1, yF);
    const ao = iso(x + u0, yF + depth);
    const bo = iso(x + u1, yF + depth);
    ctx.fillStyle = i % 2 ? colorA : colorB;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - v);
    ctx.lineTo(b.x, b.y - v);
    ctx.lineTo(bo.x, bo.y - v + drop);
    ctx.lineTo(ao.x, ao.y - v + drop);
    ctx.closePath();
    ctx.fill();
  }
  // The scalloped lip.
  const a = iso(x, yF + depth);
  const b = iso(x + width, yF + depth);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - v + drop);
  ctx.lineTo(b.x, b.y - v + drop);
  ctx.lineTo(b.x, b.y - v + drop + 3);
  ctx.lineTo(a.x, a.y - v + drop + 3);
  ctx.closePath();
  ctx.fill();
}

/** Text on a face, shrunk until it fits the width it has been given. */
function faceTextFit(ctx, x, yF, u, v, text, maxPx, size, color, weight = 700) {
  onFace(ctx, x, yF, u, v, (c) => {
    let px2 = size;
    c.font = `${weight} ${px2}px ui-sans-serif, system-ui, sans-serif`;
    const measured = c.measureText(text).width;
    if (measured > maxPx) {
      px2 = Math.max(2.8, (px2 * maxPx) / measured);
      c.font = `${weight} ${px2}px ui-sans-serif, system-ui, sans-serif`;
    }
    c.fillStyle = color;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillText(text, 0, 0);
  });
}

// ── street furniture ─────────────────────────────────────────────────────────────────────────

export function streetProp(ctx, prop, t) {
  const { kind, x, y } = prop;
  if (kind === 'lamp') return streetLamp(ctx, x, y);
  if (kind === 'bench') return bench(ctx, x, y);
  if (kind === 'bin') return bin(ctx, x, y);
  if (kind === 'hydrant') return hydrant(ctx, x, y);
  if (kind === 'tree') return tree(ctx, x, y);
  if (kind === 'busStop') return busStop(ctx, x, y, t);
  if (kind === 'newsstand') return newsstand(ctx, x, y, t);
  if (kind === 'phoneBox') return phoneBox(ctx, x, y, t);
  if (kind === 'trafficLight') return trafficLight(ctx, x, y, t);
  if (kind === 'bollard') return bollard(ctx, x, y);
  if (kind === 'parked') return car(ctx, x, y, prop.index, 1, t, 1);
  if (kind === 'drain') return drain(ctx, x, y);
  if (kind === 'pigeon') return pigeon(ctx, x, y, t);
  return undefined;
}

/** A street tree: a trunk in a grate, and a canopy that stays put. */
function tree(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.5);
  ctx.fillStyle = '#2a2f36';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, 9, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  px(ctx, p.x - 2, p.y - 22, '#5a4028', 4, 22);
  for (const [dx, dy, r, c] of [
    [-8, -26, 8, '#2f6b3e'],
    [7, -29, 8, '#3fa34d'],
    [-1, -35, 9, '#3fa34d'],
    [8, -22, 7, '#2b7a3a'],
    [-9, -20, 7, '#3fa34d'],
    [0, -27, 8, '#4ab35b'],
  ]) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(p.x + dx, p.y + dy, r, r * 0.68, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A bus shelter: a glass box with a lit route board and a bench under it. */
function busStop(ctx, x, y, t) {
  const w = 2.4;
  isoBox(ctx, x, y + 0.25, w, 0.5, 3, '#3a4049', '#272c33', '#2f353d');
  for (const u of [0.1, w - 0.1]) {
    const p = iso(x + u, y + 0.72);
    px(ctx, p.x - 1, p.y - 34, '#4a515c', 2, 34);
  }
  // The back glass, and the roof over it.
  faceQuad(ctx, x, y + 0.28, 0.12, w - 0.12, 6, 32, 'rgba(150,190,215,0.28)');
  faceQuad(ctx, x, y + 0.28, 0.12, w - 0.12, 6, 7, '#39414b');
  isoBox(ctx, x - 0.05, y + 0.18, w + 0.1, 0.62, 3, '#5a626e', '#333941', '#454c56', 34);
  // The bench inside, and the lit route board on the end.
  isoBox(ctx, x + 0.2, y + 0.42, w - 0.4, 0.2, 9, C.wood, C.woodDark, '#5a3722');
  const on = Math.sin(t / 900 + x) > -0.9;
  faceQuad(ctx, x, y + 0.72, w - 0.62, w - 0.16, 12, 27, on ? '#cfe4ef' : '#7d8894');
  for (let i = 0; i < 4; i++)
    faceQuad(ctx, x, y + 0.72, w - 0.56, w - 0.24, 24 - i * 3, 25 - i * 3, '#3a4049');
}

/** A newspaper kiosk, shutters up, with a rack of papers on the counter. */
function newsstand(ctx, x, y, t) {
  const w = 1.8;
  isoBox(ctx, x, y + 0.2, w, 0.6, 26, '#2f3a45', '#243039', '#2a3540');
  faceQuad(ctx, x, y + 0.8, 0.15, w - 0.15, 10, 22, '#12181e');
  const on = Math.sin(t / 700 + x) > -0.85;
  faceQuad(ctx, x, y + 0.8, 0.22, w - 0.22, 11, 21, on ? '#ffd986' : '#8a7a52');
  faceQuad(ctx, x, y + 0.8, 0.22, w - 0.22, 11, 13.5, 'rgba(0,0,0,0.35)');
  // The counter that sticks out, and the papers stacked on it.
  isoBox(ctx, x + 0.1, y + 0.78, w - 0.2, 0.28, 3, '#8a949f', '#4c545d', '#6d7681', 10);
  for (const [u, c] of [
    [0.35, '#e8e3d6'],
    [0.7, '#d9cfc0'],
    [w - 0.5, '#e8e3d6'],
  ]) {
    const p = iso(x + u, y + 0.9);
    px(ctx, p.x - 3, p.y - 15, c, 6, 4);
    px(ctx, p.x - 3, p.y - 16, '#b9b0a2', 6, 1);
  }
  awning(ctx, x + 0.05, y + 0.8, w - 0.1, 30, 0.55, '#8f2b2b', '#f4ede0', 3);
}

/** A phone box. Nobody uses it; it is the reddest thing on the street and it earns its place. */
function phoneBox(ctx, x, y, t) {
  isoBox(ctx, x + 0.15, y + 0.3, 0.7, 0.5, 40, '#a02a26', '#6d1a17', '#8a231f');
  faceQuad(ctx, x, y + 0.8, 0.22, 0.78, 10, 36, 'rgba(150,190,215,0.3)');
  for (let i = 1; i < 4; i++)
    faceQuad(ctx, x, y + 0.8, 0.22, 0.78, 10 + i * 7, 11 + i * 7, '#8a231f');
  isoBox(ctx, x + 0.1, y + 0.25, 0.8, 0.6, 4, '#c2352f', '#6d1a17', '#8a231f', 40);
  const on = Math.sin(t / 1100 + x) > -0.8;
  faceQuad(ctx, x, y + 0.85, 0.28, 0.72, 41, 43.5, on ? '#ffe9a8' : '#9a8a62');
}

/** A traffic light at the kerb, cycling red, amber, green. */
function trafficLight(ctx, x, y, t) {
  const p = iso(x + 0.5, y + 0.5);
  px(ctx, p.x - 3, p.y - 3, '#2f353d', 7, 3);
  px(ctx, p.x - 1, p.y - 42, '#3a4049', 2, 40);
  px(ctx, p.x - 4, p.y - 56, '#2a2f36', 8, 15);
  const phase = Math.floor(t / 2600) % 3;
  const lamps = ['#e05a4a', '#f2c14e', '#5ee08a'];
  for (let i = 0; i < 3; i++) {
    px(ctx, p.x - 2, p.y - 54 + i * 4, phase === i ? lamps[i] : '#191d22', 4, 3);
  }
}

function bollard(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.5);
  px(ctx, p.x - 2, p.y - 11, '#4a515c', 4, 11);
  px(ctx, p.x - 2, p.y - 13, '#5f6874', 4, 3);
  px(ctx, p.x - 2, p.y - 7, '#c9a227', 4, 2);
}

/**
 * A street lamp. Lit from dusk to dawn and never blinking in between: a lamp that blinks reads
 * as a fault, not as a night. By day it is a grey lantern on a post.
 */
function streetLamp(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.5);
  const h = 46;
  const lamps = sky.light.lamps;
  px(ctx, p.x - 3, p.y - 3, '#3a4049', 7, 3);
  px(ctx, p.x - 1, p.y - h, '#454c57', 2, h - 2);
  px(ctx, p.x - 1, p.y - h - 1, '#545c69', 7, 2);
  px(ctx, p.x + 4, p.y - h + 1, lamps > 0.5 ? '#ffe9a8' : '#c9ccd2', 5, 4);
  if (lamps < 0.02) return;
  ctx.save();
  ctx.globalAlpha = 0.09 * lamps;
  ctx.fillStyle = '#ffe1a0';
  ctx.beginPath();
  ctx.moveTo(p.x + 6, p.y - h + 4);
  ctx.lineTo(p.x + 24, p.y + 5);
  ctx.lineTo(p.x - 12, p.y + 5);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 0.07 * lamps;
  ctx.beginPath();
  ctx.ellipse(p.x + 6, p.y + 2, 20, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function bench(ctx, x, y) {
  isoBox(ctx, x + 0.05, y + 0.3, 0.9, 0.4, 7, C.wood, C.woodDark, '#5a3722');
  isoBox(ctx, x + 0.05, y + 0.3, 0.9, 0.1, 12, C.woodLight, C.wood, C.woodDark, 7);
  const p = iso(x + 0.5, y + 0.5);
  px(ctx, p.x - 12, p.y - 3, '#3a4049', 2, 4);
  px(ctx, p.x + 10, p.y + 2, '#3a4049', 2, 4);
}

function bin(ctx, x, y) {
  isoBox(ctx, x + 0.28, y + 0.28, 0.44, 0.44, 13, '#3f4650', '#2d333b', '#374049');
  const p = iso(x + 0.5, y + 0.5, 13);
  px(ctx, p.x - 6, p.y - 2, '#525b67', 12, 2);
  px(ctx, p.x - 2, p.y - 5, '#6d7683', 5, 3);
}

function hydrant(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.5);
  px(ctx, p.x - 3, p.y - 11, '#c0392b', 6, 11);
  px(ctx, p.x - 5, p.y - 8, '#c0392b', 10, 3);
  px(ctx, p.x - 2, p.y - 14, '#e0503f', 4, 3);
  px(ctx, p.x - 4, p.y - 1, '#8e2a1f', 8, 2);
}

function drain(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.5);
  ctx.fillStyle = '#1d2128';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, 7, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2f353e';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y - 0.5, 5.5, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();
}

function pigeon(ctx, x, y, t) {
  const p = iso(x, y);
  const peck = Math.sin(t / 700 + x) > 0.75 ? 1 : 0;
  px(ctx, p.x - 2, p.y - 4 + peck, '#5f6773', 5, 3);
  px(ctx, p.x + 2, p.y - 5 + peck, '#6f7885', 2, 2);
  px(ctx, p.x + 4, p.y - 5 + peck, '#e0a03a', 1, 1);
  px(ctx, p.x - 1, p.y - 1, '#c0392b', 1, 1);
  px(ctx, p.x + 1, p.y - 1, '#c0392b', 1, 1);
}

// ── traffic ──────────────────────────────────────────────────────────────────────────────────

const CAR_SKINS = [
  { body: '#d5a021', roof: '#f0c14e' },
  { body: '#3c5f8a', roof: '#4d78ab' },
  { body: '#7a3b46', roof: '#94505c' },
];

/** A car on the road. `dir` is +1 for the near lane and -1 for the far one. */
export function car(ctx, x, y, index, dir, t, fade = 1) {
  if (fade <= 0.01) return;
  const skin = CAR_SKINS[index % CAR_SKINS.length];
  const w = 2.1;
  const h = 12;
  const yF = y + 0.85;
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.save();
  ctx.globalAlpha = 0.3 * fade;
  ctx.fillStyle = '#000';
  const shadow = iso(x + w / 2, y + 0.45);
  ctx.beginPath();
  ctx.ellipse(shadow.x, shadow.y, 22, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  isoBox(ctx, x, y + 0.15, w, 0.7, h, skin.roof, tint(skin.body, -28), skin.body, 3);
  isoBox(
    ctx,
    x + 0.45,
    y + 0.2,
    w - 0.95,
    0.6,
    8,
    tint(skin.roof, 12),
    tint(skin.body, -20),
    tint(skin.body, 10),
    h + 3,
  );
  faceQuad(ctx, x + 0.5, yF - 0.15, 0, w - 1.05, h + 5, h + 9.5, '#9fc4dd');
  for (const u of [0.5, w - 0.5]) {
    const p = iso(x + u, yF);
    ctx.fillStyle = '#15171b';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 2, 4, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Headlights lead, tail lights follow. The lights are on all day — this is Norway — but
  // they only throw a pool on the road after dark.
  const nose = iso(dir > 0 ? x + w : x, yF - 0.1);
  px(ctx, nose.x - 2, nose.y - 9, '#fff3c9', 3, 2);
  const tail = iso(dir > 0 ? x : x + w, yF - 0.1);
  px(ctx, tail.x - 1, tail.y - 9, '#e05a4a', 2, 2);
  ctx.save();
  ctx.globalAlpha = 0.14 * fade * sky.light.lamps;
  ctx.fillStyle = '#fff3c9';
  ctx.beginPath();
  ctx.ellipse(nose.x + dir * 16, nose.y - 2, 20, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// ── the restaurant, seen from the street ─────────────────────────────────────────────────────

/** The restaurant's own colours: warm brick and gold, warmer than anything else on the block. */
const HOUSE_SKIN = {
  band: '#2a1712',
  trim: '#e8b64c',
  awningA: '#8f2b2b',
  awningB: '#f4ede0',
};

/**
 * The frontage. The rooms are cutaways — no roof, no front wall — so the only thing between the
 * dining room and the pavement is this: a knee wall with a brass rail along the terrace, a gap
 * where the door is, and a canopy over the gap with the house name on it. Low enough that it
 * never hides a diner, tall enough that inside and outside are two places.
 */
export function restaurantTerrace(ctx, house, t) {
  const { ox, w, d, door } = house;
  const skin = HOUSE_SKIN;
  const y = d - 0.14;
  const H = 14;

  for (const [x0, x1] of [
    [ox, door.x],
    [door.x + 1, ox + w],
  ]) {
    if (x1 - x0 < 0.2) continue;
    isoBox(ctx, x0, y, x1 - x0, 0.28, H, '#8a6248', '#4a3124', '#6b4a3a');
    const a = iso(x0, y + 0.28);
    const b = iso(x1, y + 0.28);
    ctx.strokeStyle = '#d4a73a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - H - 7);
    ctx.lineTo(b.x, b.y - H - 7);
    ctx.stroke();
    for (let x = x0 + 0.1; x <= x1; x += 1.4) {
      const p = iso(x, y + 0.28);
      px(ctx, p.x - 1, p.y - H - 7, '#b8892a', 2, 8);
    }
    for (let x = x0 + 0.6; x < x1 - 0.6; x += 2.4) {
      const p = iso(x, y + 0.28);
      px(ctx, p.x - 7, p.y - H - 3, '#5a3f2c', 15, 4);
      for (const [dx, dy, c] of [
        [-5, -6, '#2f6b3e'],
        [-1, -8, '#3fa34d'],
        [3, -6, '#4ab35b'],
        [6, -5, '#2f6b3e'],
        [1, -5, '#d9548a'],
      ]) {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.ellipse(p.x + dx, p.y - H - 3 + dy, 3.5, 2.4, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const mat = iso(door.x + 0.5, d + 0.5);
  ctx.fillStyle = '#7a2f2f';
  ctx.beginPath();
  ctx.moveTo(mat.x, mat.y - 6);
  ctx.lineTo(mat.x + 12, mat.y);
  ctx.lineTo(mat.x, mat.y + 6);
  ctx.lineTo(mat.x - 12, mat.y);
  ctx.closePath();
  ctx.fill();
  isoBox(ctx, door.x, d - 0.1, 1, 0.2, 3, '#9aa2b0', '#5f6672', '#7d8492');

  for (const u of [-0.2, 1.2]) {
    const p = iso(door.x + u, d + 0.9);
    px(ctx, p.x - 1, p.y - 46, '#3a2a22', 2, 46);
  }
  awning(ctx, door.x - 0.4, d, 1.8, 48, 0.95, skin.awningA, skin.awningB);
  faceQuad(ctx, door.x - 0.4, d + 0.95, 0, 1.8, 33, 41, skin.band);
  faceQuad(ctx, door.x - 0.4, d + 0.95, 0, 1.8, 40.4, 41, skin.trim);
  faceTextFit(ctx, door.x - 0.4, d + 0.95, 0.9, 35, house.name.toUpperCase(), 26, 5.2, skin.trim);

  const lamp = iso(door.x + 0.5, d + 0.55);
  const lamps = sky.light.lamps;
  const glow = lamps > 0.5 && Math.sin(t / 800) > -0.94;
  px(ctx, lamp.x - 1, lamp.y - 40, '#3a2a22', 2, 6);
  px(ctx, lamp.x - 3, lamp.y - 35, glow ? '#ffe9a8' : '#c8b47e', 6, 5);
  if (glow) {
    ctx.save();
    ctx.globalAlpha = 0.14 * lamps;
    ctx.fillStyle = '#ffe1a0';
    ctx.beginPath();
    ctx.ellipse(lamp.x, lamp.y + 2, 24, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * The silhouette of a house, for working out whether the pointer is over it: its floor, and the
 * two back walls standing at the far side of it.
 */
export function houseSilhouette(house) {
  const { ox, w, d } = house;
  const top = HOUSE_WALL_H;
  return [
    iso(ox, d),
    iso(ox + w, d),
    iso(ox + w, 0),
    { x: iso(ox + w, 0).x, y: iso(ox + w, 0).y - top },
    { x: iso(ox, 0).x, y: iso(ox, 0).y - top },
    { x: iso(ox, d).x, y: iso(ox, d).y - top },
  ];
}

/** The railing along the quay, from tile column `x0` to `x1`: the pavement stops at the water. */
export function backRailing(ctx, x0, x1, y) {
  const a = iso(x0, y);
  const b = iso(x1, y);
  ctx.strokeStyle = '#3d434d';
  ctx.lineWidth = 2;
  for (const v of [16, 9]) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - v);
    ctx.lineTo(b.x, b.y - v);
    ctx.stroke();
  }
  for (let x = x0; x <= x1; x += 0.5) {
    const p = iso(x, y);
    px(ctx, p.x - 1, p.y - 18, '#464d57', 2, 18);
  }
}
