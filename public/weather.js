// The weather, as it looks: what falls, the fog, the flash of a storm, and the shadows of
// broken cloud crossing the town.
//
// What falls is drawn on the glass — in screen pixels, after the world and before the labels
// — because rain in an isometric town has no depth to be at, and drops that scaled with the
// zoom would turn to hail at one end and mist at the other. Cloud shadows are the opposite:
// they lie on the ground and the roofs, so they are drawn in the world at its own scale.
//
// Every drop and flake is placed by a hash of its index and moved by the clock, so the sky
// needs no state between frames and looks the same on every screen.

import { hash } from './draw.js';

/** How much is falling, 0..1, taking a sleet as half rain and half snow. */
function falling(weather, kind) {
  if (!weather?.kind) return 0;
  if (weather.kind === kind) return weather.intensity;
  if (weather.kind === 'sleet') return weather.intensity * 0.5;
  return 0;
}

/** Everything on the glass: rain, snow, fog and lightning, in that order. */
export function drawWeather(ctx, cw, ch, t, light, weather) {
  if (!weather) return;
  const rain = falling(weather, 'rain');
  const snow = falling(weather, 'snow');
  // Wind leans the rain over; the forecast gives metres per second.
  const lean = Math.min(0.6, (weather.wind ?? 0) * 0.05);

  if (rain > 0) {
    const n = Math.round((rain * cw * ch) / 2600);
    const speed = 0.55 + rain * 0.45; // px per ms
    const span = ch + 60;
    ctx.save();
    ctx.strokeStyle = light.day > 0.5 ? 'rgba(110,130,160,0.6)' : 'rgba(190,205,230,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const h = hash(`r${i}`);
      const phase = (h >>> 8) % 4096;
      const y = ((t * speed + phase * 3) % span) - 60;
      const x = (((h % 4096) / 4096) * cw + y * lean + cw) % cw;
      const len = 9 + (h % 7) + rain * 6;
      ctx.moveTo(x, y);
      ctx.lineTo(x + lean * len, y + len);
    }
    ctx.stroke();
    ctx.restore();
  }

  if (snow > 0) {
    const n = Math.round((snow * cw * ch) / 5000);
    const span = ch + 40;
    ctx.save();
    ctx.fillStyle = 'rgba(240,245,255,0.9)';
    for (let i = 0; i < n; i++) {
      const h = hash(`s${i}`);
      const phase = (h >>> 8) % 4096;
      const size = 1 + (h % 3);
      const speed = 0.05 + size * 0.02;
      const y = ((t * speed + phase * 2) % span) - 40;
      const sway = Math.sin(t / 1400 + (h % 31)) * 10;
      const x = (((h % 4096) / 4096) * cw + sway + y * lean * 0.5 + cw) % cw;
      ctx.fillRect(Math.round(x), Math.round(y), size, size);
    }
    ctx.restore();
  }

  if (weather.fog) {
    ctx.save();
    // By day a fog is a white the town shows through; by night it is the lamps' own glow
    // come back off the air.
    ctx.fillStyle = light.day > 0.4 ? 'rgba(215,220,228,0.28)' : 'rgba(110,120,140,0.26)';
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();
  }

  if (weather.thunder) {
    // A flash most cycles, in two beats, then a long dark.
    const period = 9000;
    const cycle = t % period;
    const which = Math.floor(t / period);
    if (hash(`f${which}`) % 4 !== 0 && (cycle < 70 || (cycle > 130 && cycle < 190))) {
      ctx.save();
      ctx.fillStyle = 'rgba(235,240,255,0.32)';
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
    }
  }
}

/**
 * The shadows of a broken sky drifting over the town: soft ovals crossing the view in world
 * space, only when there is both sun to cast them and cloud to break it.
 */
export function drawCloudShadows(ctx, view, t, light, weather) {
  const cloud = weather?.cloud ?? 0;
  if (cloud < 0.15 || cloud > 0.92 || light.day < 0.25) return;
  // Most under a half-and-half sky; a wisp of cloud or a nearly full one casts little.
  const strength = light.day * (1 - Math.abs(cloud - 0.55) / 0.45) * 0.34;
  if (strength <= 0.01) return;
  const cell = 900;
  const drift = t * 0.012; // world units per ms, roughly a walking pace across the tiles
  const x0 = Math.floor((view.x0 - drift) / cell) - 1;
  const x1 = Math.floor((view.x1 - drift) / cell) + 1;
  const y0 = Math.floor(view.y0 / cell) - 1;
  const y1 = Math.floor(view.y1 / cell) + 1;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  for (let i = x0; i <= x1; i++) {
    for (let j = y0; j <= y1; j++) {
      const h = hash(`c${i},${j}`);
      if (h % 5 === 0) continue; // a gap in the cloud
      const cx = i * cell + ((h >>> 4) % cell) + drift;
      const cy = j * cell + ((h >>> 14) % cell);
      const rx = 260 + (h % 200);
      const ry = 120 + ((h >>> 9) % 90);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
      g.addColorStop(0, `rgba(70,80,110,${strength})`);
      g.addColorStop(0.7, `rgba(70,80,110,${strength * 0.6})`);
      g.addColorStop(1, 'rgba(70,80,110,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
