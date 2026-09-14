// The world as the page streams it: every machine's latest snapshot, then only what changed.
//
// This is the same wire format the host server speaks on its own /api/stream, one snapshot
// per message, with one addition: each carries `sourceKey`, the machine it describes, so a
// single stream can stand in for the several the page would otherwise open. A function ends
// when its time is up; the EventSource reconnects and the backlog is replayed from the store.

import { viewer, unauthorized } from '../cloud/auth.js';
import { snapshots, watching, configured } from '../cloud/store.js';

const TICK_MS = 2_500;
/** A little short of the function's 300 s cap, so the stream closes itself rather than dying. */
const LIFETIME_MS = 280_000;
const HEARTBEAT_MS = 4_000;

export async function GET(request) {
  if (!viewer(request)) return unauthorized();
  const encoder = new TextEncoder();
  const watcherId = crypto.randomUUID();
  let alive = true;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          alive = false;
        }
      }, HEARTBEAT_MS);
      const seq = new Map();
      const lastAt = new Map();
      const started = Date.now();
      // Tell the page at once when the cloud has nothing to say, rather than let it stare.
      if (!configured())
        send({ sourceKey: 'cloud', agents: [], events: [], error: 'cloud has no store yet' });
      while (alive && Date.now() - started < LIFETIME_MS) {
        const tickStart = Date.now();
        try {
          if (configured()) {
            await watching(watcherId);
            const { hosts, seq: seen } = await snapshots(seq);
            for (const snap of hosts) {
              // Only a changed snapshot or new events go out; a quiet machine costs nothing.
              // A heartbeat moves seenAt and nothing else, so seenAt is not part of this.
              const stamp = `${snap.at}|${snap.error ?? ''}|${(snap.pins ?? []).join(',')}`;
              if (!snap.events.length && lastAt.get(snap.sourceKey) === stamp) continue;
              lastAt.set(snap.sourceKey, stamp);
              send(snap);
            }
            for (const [host, n] of seen) seq.set(host, n);
          }
        } catch (err) {
          try {
            send({ sourceKey: 'cloud', agents: [], events: [], error: err.message });
          } catch {
            alive = false;
          }
        }
        const wait = Math.max(250, TICK_MS - (Date.now() - tickStart));
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      clearInterval(beat);
      try {
        controller.close();
      } catch {
        // already gone
      }
    },
    cancel() {
      alive = false;
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    },
  });
}
