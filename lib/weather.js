// The weather over the town, from the Norwegian Meteorological Institute.
//
// api.met.no's location forecast is free and needs no key; what it asks for in return is an
// identifying User-Agent and that the forecast not be fetched more often than it changes. So
// the server fetches it once, keeps it, and re-asks only when the copy it has is stale or the
// institute's own Expires header says it may. The browser never talks to the institute: it
// asks this server, which answers from the copy.
//
// The forecast is boiled down to the few numbers the picture can use — how much cloud, what
// is falling and how hard, whether there is fog or thunder — plus the temperature and the
// symbol for the header. What the town looks like under each is scene.js's business.

const FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const USER_AGENT = 'superset-agent-fleet/1.0 github.com/skriptr-ai/superset-agent-fleet';

/** How long a fetched forecast is trusted, in the absence of an Expires header. */
const TTL_MS = 30 * 60_000;
/** How long to wait after a failed fetch before asking again. */
const RETRY_MS = 5 * 60_000;

/**
 * One met.no symbol code, as what it means for the picture. The code is a base word with an
 * optional `_day`/`_night`/`_polartwilight` suffix, and the base word is built out of parts:
 * `heavyrainshowersandthunder` is heavy, rain, showers, and thunder.
 */
export function readSymbol(code) {
  const base = String(code ?? '')
    .toLowerCase()
    .replace(/_(day|night|polartwilight)$/, '');
  const thunder = base.includes('thunder');
  const fog = base === 'fog';
  const kind = base.includes('sleet')
    ? 'sleet'
    : base.includes('snow')
      ? 'snow'
      : base.includes('rain')
        ? 'rain'
        : null;
  const intensity = !kind ? 0 : base.startsWith('heavy') ? 1 : base.startsWith('light') ? 0.4 : 0.7;
  const cloud =
    base === 'clearsky' || !base
      ? 0
      : base === 'fair'
        ? 0.25
        : base === 'partlycloudy'
          ? 0.55
          : // Cloudy, fog, and anything that is falling out of a sky.
            1;
  return { symbol: base || null, kind, intensity, cloud, fog, thunder };
}

/**
 * The forecast's entry for now — the last one that has started, else the first — as the
 * summary the page uses. Throws on a document that is not a location forecast.
 */
export function summarize(forecast, now = Date.now()) {
  const series = forecast?.properties?.timeseries;
  if (!Array.isArray(series) || !series.length) throw new Error('no timeseries in forecast');
  let entry = series[0];
  for (const item of series) {
    if (Date.parse(item.time) <= now) entry = item;
    else break;
  }
  const instant = entry.data?.instant?.details ?? {};
  const next = entry.data?.next_1_hours ?? entry.data?.next_6_hours ?? {};
  const sky = readSymbol(next.summary?.symbol_code);
  const cloudFraction =
    typeof instant.cloud_area_fraction === 'number' ? instant.cloud_area_fraction / 100 : null;
  return {
    at: entry.time,
    temperature: instant.air_temperature ?? null,
    wind: instant.wind_speed ?? null,
    precipitation: next.details?.precipitation_amount ?? null,
    ...sky,
    // The symbol says what the sky is doing; the fraction says how much of it. Take the
    // fraction when there is one, but never let it argue a raining sky down to a clear one.
    cloud: cloudFraction === null ? sky.cloud : Math.max(cloudFraction, sky.kind ? 1 : 0),
  };
}

/** A forecast for one place, fetched when asked for and kept until it goes stale. */
export class Weather {
  #place;
  #fetch;
  #summary = null;
  #error = null;
  #freshUntil = 0;
  #inflight = null;

  constructor(place, fetchImpl = globalThis.fetch) {
    this.#place = place;
    this.#fetch = fetchImpl;
  }

  /** What the page gets: the place, the summary if there is one, and why not if there isn't. */
  async current() {
    if (Date.now() >= this.#freshUntil) await this.#refresh();
    return { place: this.#place, weather: this.#summary, error: this.#error };
  }

  async #refresh() {
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#load().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #load() {
    const { lat, lon } = this.#place;
    const url = `${FORECAST_URL}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
    try {
      const res = await this.#fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`met.no answered ${res.status}`);
      this.#summary = summarize(await res.json());
      this.#error = null;
      const expires = Date.parse(res.headers.get('expires') ?? '');
      this.#freshUntil = Math.max(
        Date.now() + 60_000,
        Number.isNaN(expires) ? Date.now() + TTL_MS : Math.min(expires, Date.now() + TTL_MS),
      );
    } catch (err) {
      // A forecast that could not be fetched is still the last one that could; say why and
      // keep showing it. With none at all the page draws clear skies and says so.
      this.#error = err.message;
      this.#freshUntil = Date.now() + RETRY_MS;
    }
  }
}
