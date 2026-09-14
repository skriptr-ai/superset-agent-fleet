import { configured } from '../cloud/store.js';
export async function GET() {
  return Response.json({ ok: true, cloud: true, store: configured() });
}
