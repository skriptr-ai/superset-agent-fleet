// Two doors, kept apart.
//
// Machines PUSH with a key of their own, one per machine, so one can be revoked without
// touching the rest and none can report as another. People VIEW with a single token that
// becomes a cookie, because a page is the wrong place to carry a bearer header and an
// EventSource cannot send one anyway. A leaked push key therefore opens nothing to read, and
// a leaked view token can write nothing but a pin.
//
// Both live in Doppler and reach here as environment variables: AGENT_FLEET_PUSH_KEYS is a
// JSON map of machine label to key, AGENT_FLEET_VIEW_TOKEN the one word that opens the page.
//
// The label is ours ("jonas-mac"), not Superset's name for the machine, which nobody knows
// until it reports. The store binds label to host name on the first report and holds the
// key to that name afterwards, so a key issued to one machine cannot speak for another.

import { timingSafeEqual } from 'node:crypto';

const VIEW_TOKEN = process.env.AGENT_FLEET_VIEW_TOKEN ?? '';
export const COOKIE = 'fleet_view';

let pushKeys = null;
function keys() {
  if (pushKeys) return pushKeys;
  try {
    pushKeys = JSON.parse(process.env.AGENT_FLEET_PUSH_KEYS || '{}');
  } catch {
    pushKeys = {};
  }
  return pushKeys;
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The label a push's bearer key was issued to, or null when it matches none. */
export function pushingLabel(request) {
  const header = request.headers.get('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!key) return null;
  for (const [label, issued] of Object.entries(keys())) if (same(issued, key)) return label;
  return null;
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/**
 * Whether a request may read the world. With no view token configured nothing is readable:
 * a public URL that shows every terminal screen must never be open by accident.
 */
export function viewer(request) {
  if (!VIEW_TOKEN) return false;
  if (same(cookieValue(request, COOKIE), VIEW_TOKEN)) return true;
  const url = new URL(request.url);
  return same(url.searchParams.get('token') ?? '', VIEW_TOKEN);
}

export const isViewToken = (token) => Boolean(VIEW_TOKEN) && same(token, VIEW_TOKEN);

export const unauthorized = () => new Response('unauthorized', { status: 401 });

/** The cookie a successful login sets: a year long, this site only, never readable by script. */
export function viewCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
}
