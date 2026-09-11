// met.no's symbols and timeseries, boiled down to what the picture draws.

import { describe, expect, test } from 'bun:test';
import { readSymbol, summarize, Weather } from '../lib/weather.js';

describe('readSymbol', () => {
  test('the suffix is dropped and the parts are read', () => {
    expect(readSymbol('clearsky_day')).toMatchObject({ symbol: 'clearsky', kind: null, cloud: 0 });
    expect(readSymbol('heavyrainshowersandthunder_night')).toMatchObject({
      kind: 'rain',
      intensity: 1,
      cloud: 1,
      thunder: true,
    });
    expect(readSymbol('lightsleet')).toMatchObject({ kind: 'sleet', intensity: 0.4 });
    expect(readSymbol('snow_polartwilight')).toMatchObject({ kind: 'snow', intensity: 0.7 });
    expect(readSymbol('fog')).toMatchObject({ fog: true, cloud: 1 });
    expect(readSymbol('partlycloudy_day')).toMatchObject({ cloud: 0.55 });
  });
  test('nothing at all is a clear sky', () => {
    expect(readSymbol(undefined)).toMatchObject({ symbol: null, kind: null, cloud: 0 });
  });
});

const forecast = {
  properties: {
    timeseries: [
      {
        time: '2026-09-11T07:00:00Z',
        data: {
          instant: { details: { air_temperature: 14.2, wind_speed: 3.1, cloud_area_fraction: 12 } },
          next_1_hours: {
            summary: { symbol_code: 'fair_day' },
            details: { precipitation_amount: 0 },
          },
        },
      },
      {
        time: '2026-09-11T08:00:00Z',
        data: {
          instant: {
            details: { air_temperature: 16.8, wind_speed: 2.4, cloud_area_fraction: 6.2 },
          },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
        },
      },
      {
        time: '2026-09-11T09:00:00Z',
        data: {
          instant: { details: { air_temperature: 15, wind_speed: 6, cloud_area_fraction: 40 } },
          next_1_hours: {
            summary: { symbol_code: 'rain' },
            details: { precipitation_amount: 1.4 },
          },
        },
      },
    ],
  },
};

describe('summarize', () => {
  test('picks the entry that has started and reads its hour', () => {
    const s = summarize(forecast, Date.parse('2026-09-11T08:26:00Z'));
    expect(s).toMatchObject({ at: '2026-09-11T08:00:00Z', temperature: 16.8, symbol: 'clearsky' });
    expect(s.cloud).toBeCloseTo(0.062);
  });
  test('a raining sky is overcast whatever the fraction says', () => {
    const s = summarize(forecast, Date.parse('2026-09-11T09:30:00Z'));
    expect(s).toMatchObject({ kind: 'rain', cloud: 1, precipitation: 1.4 });
  });
  test('before the first entry, the first entry', () => {
    expect(summarize(forecast, Date.parse('2026-09-11T01:00:00Z')).at).toBe('2026-09-11T07:00:00Z');
  });
  test('not a forecast is an error, not a clear sky', () => {
    expect(() => summarize({})).toThrow();
  });
});

describe('Weather', () => {
  const place = { name: 'Oslo', tz: 'Europe/Oslo', lat: 59.9139, lon: 10.7522 };
  test('fetches once, identifies itself, and keeps the copy', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, ua: init.headers['user-agent'] });
      return new Response(JSON.stringify(forecast), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const w = new Weather(place, fetchImpl);
    const a = await w.current();
    const b = await w.current();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('lat=59.9139&lon=10.7522');
    expect(calls[0].ua).toContain('superset-agent-fleet');
    expect(a.place).toBe(place);
    expect(a.weather.symbol).toBeDefined();
    expect(a.error).toBeNull();
    expect(b.weather).toBe(a.weather);
  });
  test('a failed fetch is reported, with whatever was last known', async () => {
    const w = new Weather(place, async () => {
      throw new Error('offline');
    });
    const r = await w.current();
    expect(r.weather).toBeNull();
    expect(r.error).toBe('offline');
  });
});
