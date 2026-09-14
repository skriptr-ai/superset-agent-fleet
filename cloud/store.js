// The cloud's memory: where every machine's last word about itself is kept.
//
// The fleet view on Vercel cannot read a single terminal. Each machine reads itself and pushes
// the result here (lib/report.js), and the page reads it back through the functions in api/.
// So this is the whole of what the public URL knows, and it is deliberately little: the latest
// snapshot per machine, its recent events, the pins, who is watching, and the forecast.
//
// It lives in the fleet's own Supabase project — Postgres, the thing Skriptr already runs —
// and every operation is one call to a function in cloud/schema.sql, so each is atomic and
// one round trip. The calls go over PostgREST with plain fetch, which keeps this repository
// at zero dependencies: a Vercel function has nothing to install and nothing to bundle.

const URL = (process.env.SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** A machine that has not been heard from for this long is said to be quiet. */
export const STALE_MS = 30_000;
/** And one quiet for this long has its rooms taken down: the picture must not lie for hours. */
export const GONE_MS = 10 * 60_000;

export const configured = () => Boolean(URL && KEY);

/** Call one of the schema's functions with named arguments; returns what it returned. */
export async function rpc(fn, args = {}) {
  if (!configured())
    throw new Error('no store: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set');
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      // A legacy service-role key is a JWT and goes in both places; a new secret key is not a
      // JWT and must not be offered as one.
      ...(KEY.startsWith('ey') ? { authorization: `Bearer ${KEY}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`store ${fn} answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Take in what a machine pushed under the label its key was issued to. `snapshot` is its latest world without events; `events` are
 * the ones new since its last push; `heartbeat` says nothing changed and only the clock moves;
 * `pinChanges` are pins made on the machine's own page, applied before its set is read back.
 * Returns the pins the machine should hold, so a pin made on the public page reaches it.
 */
export async function accept(
  host,
  label,
  { snapshot, events = [], pins = [], heartbeat = false, pinChanges = [] },
) {
  const answer = await rpc('fleet_push', {
    p_host: host,
    p_label: label,
    p_snapshot: heartbeat ? null : { ...snapshot, hostName: host },
    p_events: events,
    p_pins: pins,
    p_heartbeat: heartbeat,
    p_changes: pinChanges,
  });
  return { pins: answer?.pins ?? [], watchers: Number(answer?.watchers) || 0 };
}

/**
 * Every machine's latest word, as the page wants it: one snapshot per host, each carrying the
 * events newer than the sequence the caller last saw for that host (all of them for a caller
 * that has seen none). The pins are the cloud's and the same on every snapshot.
 */
export async function snapshots(lastSeq = new Map()) {
  const answer = await rpc('fleet_read', { p_since: Object.fromEntries(lastSeq) });
  const pins = answer?.pins ?? [];
  const now = Date.now();
  const seqs = new Map();
  const hosts = [];
  for (const row of answer?.hosts ?? []) {
    seqs.set(row.name, Number(row.seq) || 0);
    const seen = Number(row.seenAt) || 0;
    const quiet = now - seen;
    const entry = {
      ...row.snapshot,
      sourceKey: row.name,
      hostName: row.name,
      pins,
      seenAt: seen,
      events: row.events ?? [],
    };
    if (quiet > GONE_MS) {
      entry.agents = [];
      entry.links = [];
      entry.hubIds = [];
      entry.error = `not reporting since ${new Date(seen).toISOString().slice(11, 16)} UTC`;
    } else if (quiet > STALE_MS) {
      entry.error = `not reporting for ${Math.round(quiet / 1000)}s`;
    }
    hosts.push(entry);
  }
  return { hosts, pins, seq: seqs };
}

/** A page is looking: say so, so machines know to poll at full speed. */
export async function watching(id) {
  await rpc('fleet_watch', { p_id: id });
}

export async function setPin(id, on) {
  const answer = await rpc('fleet_pin', { p_id: id, p_on: Boolean(on) });
  return { changed: Boolean(answer?.changed), pins: answer?.pins ?? [] };
}

/** A small kept value, or null when there is none or it has expired. */
export async function kvGet(key) {
  return (await rpc('fleet_kv_get', { p_key: key })) ?? null;
}

export async function kvSet(key, value, ttlSeconds = null) {
  await rpc('fleet_kv_set', { p_key: key, p_value: value, p_ttl_seconds: ttlSeconds });
}
