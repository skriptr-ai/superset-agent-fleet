// The one write a viewer makes: a session put behind the bar by hand, or taken back out. The
// pin is the cloud's, and reaches the machine that draws that session on its next report.
import { viewer, unauthorized } from '../cloud/auth.js';
import { setPin, configured } from '../cloud/store.js';

export async function POST(request) {
  if (!viewer(request)) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) return Response.json({ ok: false, error: 'no id' }, { status: 400 });
  if (!configured())
    return Response.json({ ok: false, error: 'cloud has no store yet' }, { status: 503 });
  try {
    const { changed, pins } = await setPin(id, body.pinned !== false);
    return Response.json({ ok: true, changed, pins });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 502 });
  }
}
