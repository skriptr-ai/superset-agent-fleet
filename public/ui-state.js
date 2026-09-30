export function connectionState({
  count = 0,
  errors = false,
  reconnecting = false,
  healthy = 0,
  received = false,
}) {
  if (reconnecting && !healthy && count) return 'stale';
  if (errors || reconnecting) return count || healthy ? 'partial' : 'unavailable';
  if (!received) return 'connecting';
  return count ? 'live' : 'empty';
}

export function validSnapshot(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    (value.sourceKey == null || typeof value.sourceKey === 'string') &&
    Array.isArray(value.agents) &&
    value.agents.every(
      (agent) =>
        agent &&
        typeof agent.id === 'string' &&
        typeof agent.name === 'string' &&
        Array.isArray(agent.terminals) &&
        agent.terminals.every((terminal) => terminal && typeof terminal.id === 'string') &&
        Array.isArray(agent.queued),
    ) &&
    ['events', 'links', 'hubIds', 'pins'].every(
      (key) => value[key] == null || Array.isArray(value[key]),
    ) &&
    (value.events ?? []).every(
      (event) => event && typeof event.id === 'string' && typeof event.kind === 'string',
    ) &&
    (value.links ?? []).every(
      (link) => link && typeof link.fromId === 'string' && typeof link.toId === 'string',
    )
  );
}

/** How old an event may be, against its own machine's clock, and still be played out. */
export const LIVE_EVENT_MS = 60_000;

/**
 * Whether an event just happened, and so should walk across the room and speak.
 *
 * Asked of the event's own timestamp, never of whether this page has seen its id. The page's
 * memory is the wrong witness twice over: every machine after the first one to speak arrives
 * with its whole backlog unseen, and the cloud's backlog is several machines' 1500 events while
 * the page keeps 3000 — so each time the cloud stream reconnects, the events the page let go of
 * come back looking new. Either way a day-old reply was spoken again over an idle session.
 *
 * Judged against the snapshot's `at`, stamped by the same machine as the event, so a skewed
 * browser clock cannot silence a live one or revive an old one.
 */
export function isLiveEvent(event, snapshotAt) {
  if (event.replay || !Number.isFinite(event.at) || event.at <= 0) return false;
  const now = Number.isFinite(snapshotAt) ? snapshotAt : Date.now();
  return event.at >= now - LIVE_EVENT_MS;
}
