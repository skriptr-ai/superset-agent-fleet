// One shot of everything, for a curl rather than a page.
import { viewer, unauthorized } from '../cloud/auth.js';
import { snapshots, configured } from '../cloud/store.js';

export async function GET(request) {
  if (!viewer(request)) return unauthorized();
  if (!configured()) return Response.json({ hosts: [], error: 'cloud has no store yet' });
  try {
    const { hosts, pins } = await snapshots();
    return Response.json({ hosts, pins });
  } catch (err) {
    return Response.json({ hosts: [], error: err.message }, { status: 502 });
  }
}
