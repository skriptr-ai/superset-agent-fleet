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
