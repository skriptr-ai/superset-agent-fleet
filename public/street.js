// The street outside the restaurant: the road, the block next door, and the food carts.
//
// Same rules as the room in draw.js — whole-pixel shapes in world units, three shades to a
// solid, drawn onto a canvas the scene has already scaled. The one thing this file does that
// the room does not is write on walls: a shopfront's sign and a cart's name are painted onto
// the face they belong to with a shear, so they lie down flat in the isometry instead of
// floating in front of it.

import { TILE_W, TILE_H, iso, isoBox, px, C } from './draw.js';
import { KITCHEN_ROWS, HOUSE_WALL_H } from './district.js';

const S = {
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
function tint(hex, delta) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, v + delta));
  return `#${((c(n >> 16) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255)).toString(16).padStart(6, '0')}`;
}

/**
 * A quad on the face that looks down-left (toward the pavement), given in face coordinates:
 * `u` runs along +x in tiles from the face's left corner, `v` runs straight up in pixels.
 */
function faceQuad(ctx, x, yFront, u0, u1, v0, v1, fill) {
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
  const { w, d, houses, street, houseDepth } = district;
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

  const houseAt = (x) => houses.find((h) => x >= h.ox && x < h.ox + h.w);
  for (let x = 0; x < w; x++) {
    const house = houseAt(x);
    for (let y = 0; y < d; y++) {
      const even = (x + y) % 2 === 0;
      if (y < houseDepth) {
        if (!house) {
          // The alley between the two rooms. Outside it there is nothing behind the frontage
          // to stand on, and drawing ground there would only make the night look like a floor.
          if (x > district.alley.from && x < district.alley.to) {
            tile(`a${even}`, even ? '#20242c' : '#1d2128', '#171a20', x, y);
          }
          continue;
        }
        const key = house.key;
        if (y < KITCHEN_ROWS) {
          tile(`k${key}${even}`, even ? C.kitchenA : C.kitchenB, '#b9c3cc', x, y);
        } else if (y > house.lobbyY) {
          tile(`l${key}${even}`, even ? '#6b3f4a' : '#623943', '#4f2e37', x, y);
        } else {
          tile(`f${key}${even}`, even ? C.floorA : C.floorB, C.floorLine, x, y);
        }
        continue;
      }
      if (y >= street.roadY && y < roadEnd) {
        tile(`r${even}`, even ? S.asphalt : S.asphaltAlt, S.asphaltLine, x, y);
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
  for (const y of [street.roadY, roadEnd]) {
    const a = iso(0, y);
    const b = iso(w, y);
    kerbTop.push([a.x, a.y, b.x, b.y, b.x, b.y - 2, a.x, a.y - 2]);
    kerbFace.push([a.x, a.y, b.x, b.y, b.x, b.y + 2, a.x, a.y + 2]);
  }
  band(S.kerbTop, kerbTop);
  band(S.kerb, kerbFace);

  const dashes = [];
  const mid = street.roadY + street.roadRows / 2;
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

/** A wash of city light behind the block, so the towers have something to stand against. */
export function skyGlow(ctx, district) {
  const { w, d } = district;
  const left = iso(0, d).x - 700;
  const right = iso(w, 0).x + 700;
  const top = iso(0, 0).y - 380;
  const height = 560;
  // Both horizontal edges of the wash fade to nothing, so the only hard edges it has are the
  // vertical ones — and those are pushed far enough out to be off the canvas at any fit.
  const g = ctx.createLinearGradient(0, top, 0, top + height);
  g.addColorStop(0, 'rgba(30,40,70,0)');
  g.addColorStop(0.55, 'rgba(48,58,96,0.5)');
  g.addColorStop(0.85, 'rgba(96,80,120,0.2)');
  g.addColorStop(1, 'rgba(96,80,120,0)');
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(left, top, right - left, height);
  ctx.restore();
}

// ── the block next door ──────────────────────────────────────────────────────────────────────

/**
 * A striped canopy hanging off a face. `depth` is how far it reaches over the pavement and
 * `drop` how far its outer lip hangs below where it is fixed — between them they decide what
 * the canopy covers, which for a serving hatch is the difference between shade and a lid.
 */
function awning(ctx, x, yF, width, v, depth, colorA, colorB, drop = 7) {
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

// ── food carts ───────────────────────────────────────────────────────────────────────────────

/**
 * A van at the kerb. Its hatch faces the pavement, its name and emblem are painted on the
 * panel under the hatch, and the light and the steam are only on when the cart is open —
 * which is what tells a project's cart apart from the scenery parked beside it.
 */
export function foodCart(ctx, cart, t) {
  const { x, y, w, d, skin, closed } = cart;
  const yF = y + d;
  const box = w - 0.9; // the kitchen; the last stretch is the cab
  const base = 6; // how high the chassis rides
  const body = 27;
  const roofV = base + body;
  const centre = iso(x + w / 2, yF);

  // Light thrown onto the pavement by an open hatch.
  if (!closed) {
    ctx.save();
    ctx.globalAlpha = 0.13;
    ctx.fillStyle = '#ffd08a';
    ctx.beginPath();
    ctx.ellipse(centre.x - 6, centre.y + 11, 36, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Wheels first: the body sits on them.
  for (const u of [0.55, w - 0.5]) {
    const p = iso(x + u, yF - 0.12);
    ctx.fillStyle = '#15171b';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 4, 5.4, 4.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#4b525d';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y - 4, 2.1, 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const chassis = tint(skin.body, -52);
  faceQuad(ctx, x, yF - 0.12, 0.25, w - 0.25, 2.5, base + 1, chassis);

  // The kitchen box, then the cab at the far end.
  const roofMetal = '#b9c1cc';
  isoBox(ctx, x, y + 0.18, box, d - 0.36, body, roofMetal, tint(skin.body, -34), skin.body, base);
  isoBox(
    ctx,
    x + box,
    y + 0.24,
    w - box,
    d - 0.48,
    17,
    tint(roofMetal, -14),
    tint(skin.body, -40),
    tint(skin.body, -8),
    base,
  );
  // Cab window and door line.
  faceQuad(ctx, x, yF - 0.24, box + 0.14, w - 0.16, base + 8, base + 15, '#8fb6cf');
  faceQuad(ctx, x, yF - 0.24, box + 0.12, box + 0.16, base + 1, base + 16, tint(skin.body, -46));

  // ── the serving side ──────────────────────────────────────────────────────────────────────
  const hatch0 = base + 9;
  const hatch1 = base + 22;
  if (closed) {
    faceQuad(ctx, x, yF - 0.12, 0.3, box - 0.3, hatch0, hatch1, '#7c828d');
    for (let v = hatch0; v < hatch1; v += 2)
      faceQuad(ctx, x, yF - 0.12, 0.3, box - 0.3, v, v + 1, '#666c76');
    faceQuad(ctx, x, yF - 0.12, 0.28, box - 0.28, hatch1, hatch1 + 1, '#4c525b');
  } else {
    faceQuad(ctx, x, yF - 0.12, 0.3, box - 0.3, hatch0, hatch1, '#1c2027');
    faceQuad(ctx, x, yF - 0.12, 0.38, box - 0.38, hatch0 + 1, hatch1 - 1, '#ffcf82');
    faceQuad(ctx, x, yF - 0.12, 0.38, box - 0.38, hatch0 + 1, hatch0 + 3.5, 'rgba(0,0,0,0.35)');
    // Somebody is in there cooking.
    const bob = Math.sin(t / 520 + cart.index) * 0.1;
    faceQuad(
      ctx,
      x,
      yF - 0.12,
      0.82 + bob,
      1.3 + bob,
      hatch0 + 2,
      hatch1 - 1,
      'rgba(26,20,16,0.75)',
    );
    faceQuad(
      ctx,
      x,
      yF - 0.12,
      0.88 + bob,
      1.24 + bob,
      hatch1 - 3.2,
      hatch1 - 1.2,
      'rgba(244,240,232,0.9)',
    );
    // The counter, sticking out over the pavement.
    const a = iso(x + 0.25, yF - 0.12);
    const b2 = iso(x + box - 0.25, yF - 0.12);
    const ao = iso(x + 0.25, yF + 0.3);
    const bo = iso(x + box - 0.25, yF + 0.3);
    ctx.fillStyle = tint(skin.trim, -14);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - hatch0);
    ctx.lineTo(b2.x, b2.y - hatch0);
    ctx.lineTo(bo.x, bo.y - hatch0 + 2);
    ctx.lineTo(ao.x, ao.y - hatch0 + 2);
    ctx.closePath();
    ctx.fill();
    // Sauce bottles and a stack of trays along it.
    for (const [u, c1] of [
      [0.45, '#d94f3d'],
      [0.62, '#f2c14e'],
      [box - 0.55, '#e8e3d6'],
    ]) {
      const p = iso(x + u, yF + 0.06);
      px(ctx, p.x - 1, p.y - hatch0 - 4, c1, 3, 5);
    }
  }

  // The panel under the hatch carries the emblem.
  faceQuad(
    ctx,
    x,
    yF - 0.12,
    0.25,
    box - 0.25,
    base + 1,
    hatch0,
    tint(skin.body, closed ? -24 : -12),
  );
  faceQuad(ctx, x, yF - 0.12, 0.25, box - 0.25, hatch0 - 0.6, hatch0, tint(skin.trim, -24));
  cartEmblem(ctx, x, yF - 0.12, box / 2, base + 2.2, cart.emblem, skin, closed);

  // Roof: a flue with steam, and the frame the canopy hangs from.
  isoBox(ctx, x + 0.35, y + d / 2 - 0.22, 0.44, 0.44, 7, S.metal, S.metalDark, '#6d7683', roofV);
  isoBox(ctx, x + 1.15, y + d / 2 - 0.28, 0.6, 0.55, 5, '#9aa3af', '#5f6874', '#78818d', roofV);
  if (!closed) {
    const flue = iso(x + 0.57, y + d / 2, roofV + 7);
    for (let i = 0; i < 5; i++) {
      const phase = (t / 1500 + i / 5 + cart.index * 0.17) % 1;
      ctx.fillStyle = `rgba(226,232,240,${0.42 * (1 - phase)})`;
      ctx.fillRect(
        Math.round(flue.x - 1 + Math.sin(phase * 6 + i) * 4),
        Math.round(flue.y - 2 - phase * 28),
        2,
        2,
      );
    }
  }

  // The canopy stands clear above the roof on two posts, so it shades the hatch without
  // covering it — the thing that makes the van read as a serving window and not a crate.
  const canopyV = roofV + 6;
  for (const u of [0.18, box - 0.18]) {
    const p = iso(x + u, yF - 0.12);
    px(ctx, p.x - 1, p.y - canopyV, '#4a505a', 2, canopyV - roofV + 2);
  }
  awning(
    ctx,
    x + 0.1,
    yF - 0.12,
    box - 0.2,
    canopyV,
    0.6,
    closed ? tint(skin.trim, -40) : skin.trim,
    closed ? '#aeb4bd' : '#f7f2e7',
    3,
  );
  // The valance carries the name: it is the widest flat thing on the van.
  const lip = canopyV - 3;
  faceQuad(ctx, x + 0.1, yF + 0.48, 0, box - 0.2, lip - 6.4, lip, closed ? '#3f444c' : skin.ink);
  faceTextFit(
    ctx,
    x + 0.1,
    yF + 0.48,
    (box - 0.2) / 2,
    lip - 5,
    fit(cart.label, 26),
    (box - 0.2) * 16 - 6,
    5,
    closed ? '#9aa1ab' : skin.trim,
  );

  if (!closed) {
    for (let i = 0; i <= 7; i++) {
      const u = 0.2 + (i / 7) * (box - 0.4);
      const p = iso(x + u, yF + 0.48);
      const on = Math.sin(t / 480 + i * 0.9 + cart.index) > -0.6;
      px(ctx, p.x - 1, p.y - lip + 1, on ? '#ffe6a8' : '#8a7a52', 2, 2);
      if (on) {
        ctx.save();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = '#ffe6a8';
        ctx.beginPath();
        ctx.arc(p.x, p.y - lip + 2, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

function fit(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The emblem on a cart's panel, drawn flat on the face inside a rounded badge. */
function cartEmblem(ctx, x, yF, u, v, emblem, skin, closed) {
  onFace(ctx, x, yF, u, v, (c) => {
    c.save();
    if (closed) c.globalAlpha = 0.5;
    c.fillStyle = skin.trim;
    c.beginPath();
    c.arc(0, -3, 3.9, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = skin.ink;
    c.translate(0, -3);
    c.scale(0.064, 0.064);
    drawEmblem(c, emblem);
    c.restore();
  });
}

/** Emblems, drawn in a 100×100 box centred on the origin. */
function drawEmblem(c, emblem) {
  c.lineWidth = 9;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = c.fillStyle;
  switch (emblem) {
    case 'taco':
      c.beginPath();
      c.arc(0, 6, 38, Math.PI, 0);
      c.closePath();
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.fillRect(-26, -12, 52, 8);
      break;
    case 'bowl':
      c.beginPath();
      c.arc(0, -2, 36, 0, Math.PI);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(-30, -14);
      c.lineTo(30, -34);
      c.stroke();
      c.beginPath();
      c.moveTo(-30, -24);
      c.lineTo(30, -44);
      c.stroke();
      break;
    case 'cup':
      c.fillRect(-26, -26, 44, 54);
      c.beginPath();
      c.arc(20, -2, 16, -Math.PI / 2, Math.PI / 2);
      c.stroke();
      c.fillRect(-32, -36, 60, 10);
      break;
    case 'burger':
      c.beginPath();
      c.arc(0, -6, 36, Math.PI, 0);
      c.closePath();
      c.fill();
      c.fillRect(-36, 4, 72, 10);
      c.fillRect(-32, 20, 64, 14);
      break;
    case 'chili':
      c.beginPath();
      c.moveTo(-6, -32);
      c.quadraticCurveTo(34, -18, 20, 22);
      c.quadraticCurveTo(6, 44, -14, 26);
      c.quadraticCurveTo(-2, 6, -6, -32);
      c.fill();
      c.beginPath();
      c.moveTo(-8, -30);
      c.lineTo(-28, -40);
      c.stroke();
      break;
    case 'fish':
      c.beginPath();
      c.ellipse(-4, 0, 34, 20, 0, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.moveTo(26, 0);
      c.lineTo(44, -18);
      c.lineTo(44, 18);
      c.closePath();
      c.fill();
      break;
    case 'pretzel':
      c.lineWidth = 12;
      for (const [cx, cy] of [
        [-18, 6],
        [18, 6],
        [0, -18],
      ]) {
        c.beginPath();
        c.arc(cx, cy, 18, 0, Math.PI * 2);
        c.stroke();
      }
      break;
    default:
      c.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        const r = i % 2 ? 16 : 38;
        const px2 = Math.cos(a) * r;
        const py2 = Math.sin(a) * r;
        if (i === 0) c.moveTo(px2, py2);
        else c.lineTo(px2, py2);
      }
      c.closePath();
      c.fill();
  }
}

/** What a street eater is holding, matched to the cart they queued at. */
export function streetFood(ctx, hx, hy, emblem, t) {
  const lift = Math.round(Math.abs(Math.sin(t / 300)) * 3);
  const y = hy - lift;
  if (emblem === 'cup') {
    px(ctx, hx - 1, y - 6, '#f3ede2', 5, 6);
    px(ctx, hx - 1, y - 7, '#c9542f', 5, 1);
    steam(ctx, hx + 1, y - 8, t, 0.5);
  } else if (emblem === 'bowl') {
    px(ctx, hx - 2, y - 4, '#e8e3d6', 7, 4);
    px(ctx, hx - 1, y - 5, '#f2c14e', 5, 1);
    steam(ctx, hx + 1, y - 7, t, 0.6);
  } else if (emblem === 'taco') {
    px(ctx, hx - 2, y - 5, '#e8c274', 6, 4);
    px(ctx, hx - 1, y - 6, '#7cb342', 4, 1);
    px(ctx, hx - 1, y - 4, '#c62828', 3, 1);
  } else {
    px(ctx, hx - 2, y - 6, '#d8a05a', 6, 3);
    px(ctx, hx - 2, y - 4, '#8d5a3a', 6, 2);
    px(ctx, hx - 2, y - 7, '#e8c274', 6, 2);
  }
}

function steam(ctx, x, y, t, scale = 1) {
  for (let i = 0; i < 3; i++) {
    const phase = (t / 1100 + i / 3) % 1;
    ctx.fillStyle = `rgba(226,232,240,${0.5 * (1 - phase) * scale})`;
    ctx.fillRect(Math.round(x + Math.sin(phase * 6 + i) * 2), Math.round(y - phase * 12), 1, 2);
  }
}

// ── street furniture ─────────────────────────────────────────────────────────────────────────

export function streetProp(ctx, prop, t) {
  const { kind, x, y } = prop;
  if (kind === 'lamp') return streetLamp(ctx, x, y, t);
  if (kind === 'bench') return bench(ctx, x, y);
  if (kind === 'bin') return bin(ctx, x, y);
  if (kind === 'hydrant') return hydrant(ctx, x, y);
  if (kind === 'planter') return planter(ctx, x, y);
  if (kind === 'board') return menuBoard(ctx, x, y);
  if (kind === 'drain') return drain(ctx, x, y);
  if (kind === 'pigeon') return pigeon(ctx, x, y, t);
  return undefined;
}

function streetLamp(ctx, x, y, t) {
  const p = iso(x + 0.5, y + 0.5);
  const h = 46;
  px(ctx, p.x - 3, p.y - 3, '#3a4049', 7, 3);
  px(ctx, p.x - 1, p.y - h, '#454c57', 2, h - 2);
  px(ctx, p.x - 1, p.y - h - 1, '#545c69', 7, 2);
  const on = Math.sin(t / 900 + x) > -0.96;
  px(ctx, p.x + 4, p.y - h + 1, on ? '#ffe9a8' : '#7d7457', 5, 4);
  if (on) {
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = '#ffe1a0';
    ctx.beginPath();
    ctx.moveTo(p.x + 6, p.y - h + 4);
    ctx.lineTo(p.x + 24, p.y + 5);
    ctx.lineTo(p.x - 12, p.y + 5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.07;
    ctx.beginPath();
    ctx.ellipse(p.x + 6, p.y + 2, 20, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
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

function planter(ctx, x, y) {
  isoBox(ctx, x + 0.2, y + 0.2, 0.6, 0.6, 9, '#4a4038', '#332c26', '#3d352e');
  const p = iso(x + 0.5, y + 0.5, 9);
  px(ctx, p.x - 1, p.y - 16, '#5a4028', 2, 16);
  for (const [dx, dy, c] of [
    [-6, -20, '#2f6b3e'],
    [5, -22, '#3fa34d'],
    [-1, -27, '#3fa34d'],
    [6, -16, '#2b7a3a'],
    [-7, -14, '#3fa34d'],
    [0, -19, '#4ab35b'],
  ]) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.ellipse(p.x + dx, p.y + dy, 6, 4, 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function menuBoard(ctx, x, y) {
  const p = iso(x + 0.5, y + 0.6);
  px(ctx, p.x - 8, p.y - 20, '#4a3524', 16, 20);
  px(ctx, p.x - 6, p.y - 18, '#232a24', 12, 15);
  for (let i = 0; i < 4; i++)
    px(ctx, p.x - 4, p.y - 15 + i * 3, 'rgba(226,232,240,0.55)', 8 - i, 1);
  px(ctx, p.x - 4, p.y - 17, '#f2c14e', 8, 1);
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
  // Headlights lead, tail lights follow.
  const nose = iso(dir > 0 ? x + w : x, yF - 0.1);
  px(ctx, nose.x - 2, nose.y - 9, '#fff3c9', 3, 2);
  const tail = iso(dir > 0 ? x : x + w, yF - 0.1);
  px(ctx, tail.x - 1, tail.y - 9, '#e05a4a', 2, 2);
  ctx.save();
  ctx.globalAlpha = 0.14 * fade;
  ctx.fillStyle = '#fff3c9';
  ctx.beginPath();
  ctx.ellipse(nose.x + dir * 16, nose.y - 2, 20, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// ── the restaurants, seen from the street ────────────────────────────────────────────────────

/**
 * Each house's own colours. The two restaurants have to be told apart at a glance from across
 * the street, so they do not share a palette — one is warm brick and gold, the other slate and
 * verdigris — and both are warmer than the drab block next door.
 */
const HOUSE_SKINS = {
  orchestra: {
    face: '#8c4a3a',
    side: '#6d3729',
    top: '#a05741',
    plinth: '#4a3128',
    band: '#2a1712',
    trim: '#e8b64c',
    roof: '#7d2f2f',
    roofBack: '#5f2323',
    ridge: '#c9a227',
    awningA: '#8f2b2b',
    awningB: '#f4ede0',
    glass: '#ffcf82',
  },
  architects: {
    face: '#3f5a63',
    side: '#2f454d',
    top: '#4c6c76',
    plinth: '#26363c',
    band: '#111d21',
    trim: '#7fd4c1',
    roof: '#2f4f56',
    roofBack: '#243d43',
    ridge: '#9fb8bd',
    awningA: '#1f5a63',
    awningB: '#eef3f2',
    glass: '#bfe6dd',
  },
};

const houseSkin = (house) => HOUSE_SKINS[house.key] ?? HOUSE_SKINS.orchestra;

/**
 * The frontage. The rooms are cutaways — no roof, no front wall — so the only thing between the
 * dining room and the pavement is this: a knee wall with a brass rail along the terrace, a gap
 * where the door is, and a canopy over the gap with the house name on it. Low enough that it
 * never hides a diner, tall enough that inside and outside are two places.
 */
export function restaurantTerrace(ctx, house, t) {
  const { ox, w, d, door } = house;
  const skin = houseSkin(house);
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
  const glow = Math.sin(t / 800) > -0.94;
  px(ctx, lamp.x - 1, lamp.y - 40, '#3a2a22', 2, 6);
  px(ctx, lamp.x - 3, lamp.y - 35, glow ? '#ffe9a8' : '#c8b47e', 6, 5);
  if (glow) {
    ctx.save();
    ctx.globalAlpha = 0.14;
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

/** The railing at the front of the pavement: the world has to stop somewhere. */
export function backRailing(ctx, w, y) {
  const a = iso(0, y);
  const b = iso(w, y);
  ctx.strokeStyle = '#3d434d';
  ctx.lineWidth = 2;
  for (const v of [16, 9]) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - v);
    ctx.lineTo(b.x, b.y - v);
    ctx.stroke();
  }
  for (let x = 0; x <= w; x += 0.5) {
    const p = iso(x, y);
    px(ctx, p.x - 1, p.y - 18, '#464d57', 2, 18);
  }
}
