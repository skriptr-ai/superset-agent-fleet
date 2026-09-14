// The page asks who else to listen to. In the cloud the answer is nobody: one stream carries
// every machine. `cloud: true` tells the page that no host is home and every room is away.
import { viewer, unauthorized } from '../cloud/auth.js';

export async function GET(request) {
  if (!viewer(request)) return unauthorized();
  return Response.json({ peers: [], self: null, cloud: true });
}
