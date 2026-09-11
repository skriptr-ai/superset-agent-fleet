// The time of day, and the light it puts on the town.
//
// The city is drawn for the night — that is the palette every colour in city.js, street.js
// and draw.js was picked against — and the night is a fine thing to look at. It is also wrong
// for two thirds of a working day: at ten in the morning the fleet is not out under the
// street lamps. So the picture follows the sun over the place the fleet is in, and the night
// palette is lit up to a day one on the way through the canvas, rather than every shape in
// five files carrying two colours.
//
// Where the sun is comes from the clock and the latitude, not from a lookup: a September
// morning in Oslo is bright by seven and a December one is dusk at three, and a fixed "day is
// 06:00–18:00" would put both wrong. The weather (see lib/weather.js for where it comes from)
// dims the day under cloud and, in scene.js, puts the rain on the glass.

/** Where the fleet is, until the server says otherwise: Oslo. */
export const DEFAULT_PLACE = { name: 'Oslo', tz: 'Europe/Oslo', lat: 59.9139, lon: 10.7522 };

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => {
  const k = clamp01((v - a) / (b - a));
  return k * k * (3 - 2 * k);
};

/**
 * The sun's elevation above the horizon, in degrees, at `date` seen from (lat, lon). The
 * low-precision almanac formula: within a degree, which is far closer than the eye can tell
 * from a sky.
 */
export function sunElevation(date, lat, lon) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86_400_000; // days since J2000
  const g = rad((357.529 + 0.98560028 * d) % 360); // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360; // mean longitude
  const L = rad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)); // ecliptic longitude
  const e = rad(23.439 - 0.00000036 * d); // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24) * 15; // in degrees
  const ha = rad(gmst + lon - deg(ra));
  const la = rad(lat);
  return deg(Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)));
}

/**
 * What the light is like at `date`: how much of the day palette to use, how warm it is, and
 * whether the lamps are on. `weather` is the summary lib/weather.js produces; only its cloud
 * cover matters here.
 *
 *   day    0 at night, 1 in full sun; the ramp runs from civil dusk to a hand's-width of sun.
 *   warm   golden hour: the sun low but up.
 *   dusk   the blue-purple of the sun just under the horizon.
 *   lamps  the street lamps, headlights and lit windows; on from a degree under the horizon.
 */
export function lightAt(date, place = DEFAULT_PLACE, weather = null) {
  const elevation = sunElevation(date, place.lat, place.lon);
  const cloud = clamp01(weather?.cloud ?? 0);
  const sun = smooth(-6, 5, elevation);
  return {
    elevation,
    // Cloud takes the shine off a day without turning it into a night.
    day: sun * (1 - 0.35 * cloud),
    grey: sun * cloud,
    warm: smooth(-2, 1, elevation) * (1 - smooth(4, 14, elevation)) * (1 - cloud),
    dusk: smooth(-9, -5, elevation) * (1 - smooth(-3, 1, elevation)),
    lamps: 1 - smooth(-2, 1, elevation),
  };
}

/**
 * The light as it stands, for the shapes that draw differently by it — a lamp that is off in
 * the day, a window with sky rather than night behind it. The scene's Lighting keeps it
 * current; `shade` is the tone map for a colour that does not go through the context, such as
 * a gradient stop.
 */
export const sky = { light: lightAt(new Date()), shade: (color) => color };

// ── the tone map ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightness, night to day: what the night palette's darks become in the sun.
 *
 * A curve, not a scale. The darkness of the night scene is in its middle — pavement, tarmac,
 * building faces, all between a fifth and two fifths of the way up — while its real blacks,
 * the outlines round every figure, are under an eighth. Daylight has to lift the first group
 * to sunlit greys and leave the second alone, or every pixel figure loses its edges. So the
 * curve is steep through the middle and nearly flat at both ends.
 */
const RAMP = [
  [0, 0],
  [0.12, 0.16],
  [0.22, 0.5],
  [0.45, 0.72],
  [0.7, 0.85],
  [1, 1],
];

function ramp(l) {
  for (let i = 1; i < RAMP.length; i++) {
    const [x0, y0] = RAMP[i - 1];
    const [x1, y1] = RAMP[i];
    if (l <= x1) return y0 + ((l - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 1;
}

function parse(color) {
  if (typeof color !== 'string') return null;
  if (color[0] === '#') {
    const hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const v = (i) => parseInt(hex[i] + hex[i], 16);
      return [v(0), v(1), v(2), hex.length === 4 ? v(3) / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      const v = (i) => parseInt(hex.slice(i, i + 2), 16);
      return [v(0), v(2), v(4), hex.length === 8 ? v(6) / 255 : 1];
    }
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    color,
  );
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  return null;
}

function toHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
}

const mix = (a, b, k) => a + (b - a) * k;

/** A colour from the night palette, as it looks under `light`. */
export function shadeColor(color, light) {
  const c = parse(color);
  if (!c) return color;
  const [h, s, l] = toHsl(c[0] / 255, c[1] / 255, c[2] / 255);
  // Lift the lightness along the ramp, and let cloud take some of the colour out of it.
  const lit = mix(l, ramp(l), light.day);
  let [r, g, b] = fromHsl(h, s * (1 - 0.35 * light.grey), lit);
  // Golden hour lays orange on everything; dusk, a violet the lamps have not yet cut through.
  const warm = light.warm * 0.3;
  r = mix(r, Math.min(1, r * 1.12 + 0.08), warm);
  g = mix(g, g * 0.92, warm);
  b = mix(b, b * 0.6, warm);
  const dusk = light.dusk * 0.22;
  r = mix(r, r * 0.9 + 0.04, dusk);
  g = mix(g, g * 0.85, dusk);
  b = mix(b, Math.min(1, b * 1.05 + 0.1), dusk);
  const ch = (v) => Math.round(clamp01(v) * 255);
  return c[3] >= 1 ? `rgb(${ch(r)},${ch(g)},${ch(b)})` : `rgba(${ch(r)},${ch(g)},${ch(b)},${c[3]})`;
}

/**
 * The lighting pass, as a hook on one canvas context.
 *
 * Every shape the world is made of sets `fillStyle` or `strokeStyle` and draws; that is the
 * one door all of the night palette goes through, so the tone map stands at it. While the
 * pass is on, every colour set on the context is shaded for the current light first. Labels,
 * bubbles and the rest of the chrome are drawn with the pass off and keep their own colours.
 *
 * Shading is memoised per colour string and the memo is dropped whenever the light changes
 * enough to see, which is a few times an hour; a frame is then a map lookup per fill.
 */
export class Lighting {
  #on = false;
  #cache = new Map();
  #key = '';
  light = lightAt(new Date());

  constructor(ctx) {
    sky.light = this.light;
    sky.shade = (color) => this.shade(color);
    const proto = Object.getPrototypeOf(ctx);
    for (const name of ['fillStyle', 'strokeStyle']) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc?.set) continue;
      Object.defineProperty(ctx, name, {
        configurable: true,
        get: () => desc.get.call(ctx),
        set: (value) => desc.set.call(ctx, this.#on ? this.shade(value) : value),
      });
    }
  }

  /** Point the pass at a new light; the memo goes if it looks any different. */
  set(light) {
    this.light = light;
    sky.light = light;
    const key = ['day', 'grey', 'warm', 'dusk'].map((k) => Math.round(light[k] * 40)).join(',');
    if (key !== this.#key) {
      this.#key = key;
      this.#cache.clear();
    }
  }

  begin() {
    this.#on = true;
  }

  end() {
    this.#on = false;
  }

  /** `color` under the current light, whether or not the pass is on. */
  shade(color) {
    if (typeof color !== 'string') return color; // a gradient or pattern: already shaded
    let out = this.#cache.get(color);
    if (out === undefined) {
      out = shadeColor(color, this.light);
      this.#cache.set(color, out);
    }
    return out;
  }
}

/**
 * A moment to draw instead of now, from the page's URL — `?at=22:30` or `?at=2026-12-21T15:00`
 * — so a night or a winter afternoon can be looked at without waiting for one. Null when the
 * page is just to be live.
 */
export function pinnedTime(search, place = DEFAULT_PLACE) {
  const at = new URLSearchParams(search).get('at');
  if (!at) return null;
  if (/^\d{1,2}:\d{2}$/.test(at)) {
    // A bare time is today's, in the town's own zone: find the UTC instant that reads as it.
    const [hh, mm] = at.split(':').map(Number);
    const now = new Date();
    for (let h = -14; h <= 14; h++) {
      const guess = new Date(now);
      guess.setUTCHours(hh - h, mm, 0, 0);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: place.tz,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(guess);
      if (parts === `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`) return guess;
    }
    return null;
  }
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
