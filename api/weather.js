// The sky over the town, from the cloud's kept copy: met.no is asked at most every ten
// minutes however many pages are open, which is what the institute asks of its clients.
import { viewer, unauthorized } from '../cloud/auth.js';
import { Weather } from '../lib/weather.js';
import { kvGet, kvSet, configured } from '../cloud/store.js';

const PLACE = {
  name: process.env.AGENT_FLEET_PLACE ?? 'Oslo',
  tz: process.env.AGENT_FLEET_TZ ?? 'Europe/Oslo',
  lat: Number(process.env.AGENT_FLEET_LAT ?? 59.9139),
  lon: Number(process.env.AGENT_FLEET_LON ?? 10.7522),
};
const KEEP_S = 600;

// A warm function keeps its own copy too, so the store is only asked once per instance per tick.
const weather = new Weather(PLACE);

export async function GET(request) {
  if (!viewer(request)) return unauthorized();
  if (configured()) {
    try {
      const kept = await kvGet('weather');
      if (kept) return Response.json(kept);
    } catch {
      // The store being down is no reason to have no sky.
    }
  }
  const current = await weather.current();
  if (configured() && current.weather && !current.error) {
    try {
      await kvSet('weather', current, KEEP_S);
    } catch {
      // as above
    }
  }
  return Response.json(current);
}
