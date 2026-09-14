// Where a machine reports. One POST per poll from lib/report.js, answered with the pins the
// machine should hold and whether anyone is watching, so it knows how fast to keep polling.

import { pushingLabel, unauthorized } from '../cloud/auth.js';
import { accept, configured } from '../cloud/store.js';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }
  const issued = pushingLabel(request);
  const host = typeof body?.hostName === 'string' ? body.hostName : '';
  if (!issued || !host) return unauthorized();
  if (!configured())
    return Response.json({ ok: false, error: 'cloud has no store yet' }, { status: 503 });
  try {
    const { pins, watchers } = await accept(host, issued, {
      snapshot: body.snapshot ?? {},
      events: Array.isArray(body.events) ? body.events : [],
      pins: Array.isArray(body.pins) ? body.pins.filter((p) => typeof p === 'string') : [],
      heartbeat: body.heartbeat === true,
      pinChanges: Array.isArray(body.pinChanges) ? body.pinChanges : [],
    });
    return Response.json({ ok: true, pins, watchers });
  } catch (err) {
    // A key speaking for a machine it was not issued to is refused, not stored.
    if (err.message.includes('key_bound_elsewhere')) return unauthorized();
    return Response.json({ ok: false, error: err.message }, { status: 502 });
  }
}
