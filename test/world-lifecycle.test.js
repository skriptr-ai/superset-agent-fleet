import { describe, expect, test } from 'bun:test';
import { World } from '../lib/world.js';
import fixtures from './fixtures.json';

const workspace = (id = 'local-agent', hostId = 'local-host') => ({
  id,
  hostId,
  name: id,
  hostName: hostId,
  createdAt: new Date().toISOString(),
  tags: [],
});

function setup(scope = 'fleet') {
  const state = {
    rows: [workspace()],
    metadata: [],
    localId: 'local-host',
    incomplete: [],
    failDiscovery: false,
    discoveryError: null,
    failList: false,
    failScreen: false,
    text: fixtures.spinnerSixPointed,
    readIds: [],
    bindings: new Map(),
  };
  const source = {
    localHostId: async () => state.localId,
    localHostNameOf: () => 'Fixture Mac',
    listWorkspaces: async () => ({
      ok: !state.failDiscovery,
      error: state.failDiscovery ? 'discovery unavailable' : state.discoveryError,
      workspaces: state.rows,
      knownWorkspaces: [...state.rows, ...state.metadata],
      incompleteHostIds: state.incomplete,
      hostListComplete: !state.failDiscovery && !state.discoveryError,
      authoritativeHostIds: [...new Set(state.rows.map((row) => row.hostId))],
    }),
    listTerminalAgents: async () => state.bindings,
    listTerminals: async (id) => {
      state.readIds.push(id);
      return state.failList
        ? { ok: false, error: 'terminal list timeout', sessions: [] }
        : {
            ok: true,
            sessions: [{ terminalId: 'shared-terminal', title: 'Claude', exited: false }],
          };
    },
    readTerminal: async () =>
      state.failScreen
        ? { ok: false, error: 'screen timeout', text: '' }
        : { ok: true, text: state.text },
    lookupTasks: async () => new Map(),
  };
  const world = new World(null, null, null, scope, source);
  return { world, state, source };
}

describe('observation failures are not session lifecycle events', () => {
  for (const failure of ['failList', 'failScreen']) {
    test(`${failure} retains the last observation without false disappearance or completion`, async () => {
      const { world, state } = setup();
      const first = await world.poll();
      expect(first.agents[0].status).toBe('working');
      state[failure] = true;
      const failed = await world.poll();
      expect(failed.agents[0]).toMatchObject({
        stale: true,
        status: 'working',
        observedAt: first.agents[0].observedAt,
      });
      expect(failed.error).toContain('timeout');
      expect(failed.events).toEqual([]);
      state[failure] = false;
      state.text = fixtures.done;
      const restored = await world.poll();
      expect(restored.agents[0]).toMatchObject({ stale: false, status: 'idle' });
      expect(restored.events).toEqual([]);
      expect(restored.error).toBeNull();
    });
  }
  test('total discovery failure preserves stale observations until a successful absence', async () => {
    const { world, state } = setup();
    await world.poll();
    state.failDiscovery = true;
    const failed = await world.poll();
    expect(failed.agents).toHaveLength(1);
    expect(failed.agents[0].stale).toBe(true);
    expect(failed.events).toEqual([]);
    state.failDiscovery = false;
    state.rows = [];
    const empty = await world.poll();
    expect(empty.agents).toHaveLength(0);
    expect(empty.events.map((event) => event.kind)).toEqual(['gone']);
  });
  test('a failed remote host does not remove its sessions or poison a healthy host', async () => {
    const { world, state } = setup();
    state.rows.push(workspace('remote-agent', 'remote-host'));
    await world.poll();
    state.rows = [workspace()];
    state.incomplete = ['remote-host'];
    const partial = await world.poll();
    expect(partial.agents.find((agent) => agent.id === 'remote-agent').stale).toBe(true);
    expect(partial.agents.find((agent) => agent.id === 'local-agent').stale).toBe(false);
    expect(partial.events).toEqual([]);
    state.incomplete = [];
    const confirmed = await world.poll();
    expect(confirmed.agents).toHaveLength(1);
    expect(confirmed.events.map((event) => event.kind)).toEqual(['gone']);
  });
});

test('local host identity recovers after empty startup', async () => {
  const { world, state } = setup('host');
  state.localId = 'provisional-host';
  state.rows = [];
  expect((await world.poll()).agents).toEqual([]);
  // The first workspace appears between identity lookup and authoritative local discovery.
  state.rows = [workspace()];
  expect((await world.poll()).agents[0]).toMatchObject({ remote: false, hostId: 'local-host' });
});

test('a cloud discovery failure cannot remove an uncached remote host', async () => {
  const { world, state } = setup();
  state.rows.push(workspace('remote-agent', 'remote-host'));
  await world.poll();
  state.rows = [workspace()];
  state.discoveryError = 'cloud host listing unavailable';
  const partial = await world.poll();
  expect(partial.agents.find((agent) => agent.id === 'remote-agent').stale).toBe(true);
  expect(partial.events).toEqual([]);
});

test('an unreadable never-observed session cannot fabricate an agent', async () => {
  const { world, state } = setup();
  state.failScreen = true;
  const snapshot = await world.poll();
  expect(snapshot.agents).toEqual([]);
  expect(snapshot.error).toContain('screen timeout');
  expect(snapshot.events).toEqual([]);
});

test('unresolved evidence is bounded and expires before late metadata can revive it', async () => {
  const { world, state } = setup('host');
  let recorded = Array.from({ length: 1600 }, () => ({
    fromId: 'local-agent',
    toId: 'remote-agent',
    verb: 'send',
    at: Date.now(),
    text: 'brief',
  }));
  world.log.read = async () => {
    const batch = recorded;
    recorded = [];
    return batch;
  };
  await world.poll();
  expect(world.pendingEvidence).toHaveLength(1500);
  world.pendingEvidence.forEach((message) => (message.queuedAt = Date.now() - 6 * 60_000));
  state.metadata = [workspace('remote-agent', 'remote-host')];
  expect((await world.poll()).events).toEqual([]);
  expect(world.pendingEvidence).toEqual([]);
});

test('local terminal hook IDs never override remote terminal status', async () => {
  const { world, state } = setup();
  state.rows = [workspace('remote-agent', 'remote-host')];
  state.text = '';
  state.bindings.set('shared-terminal', { lastEventType: 'Start', agentId: 'claude' });
  expect((await world.poll()).agents[0].status).toBe('idle');
});

test('idle remote scheduling gives every session a turn', async () => {
  const { world, state } = setup();
  state.rows = Array.from({ length: 17 }, (_, i) => workspace(`remote-${i}`, 'remote-host'));
  state.text = fixtures.done;
  await world.poll();
  state.readIds = [];
  for (let i = 0; i < 5; i++) await world.poll();
  expect(new Set(state.readIds).size).toBe(17);
  expect(state.readIds).toHaveLength(20);
});

test('background metadata delay does not lose or duplicate recorded cross-host messages', async () => {
  const { world, state } = setup('host');
  let recorded = [
    {
      fromId: 'local-agent',
      toId: 'remote-agent',
      verb: 'send',
      text: 'A fictional brief',
      at: Date.now(),
      replay: true,
    },
  ];
  world.log.read = async () => {
    const batch = recorded;
    recorded = [];
    return batch;
  };
  expect((await world.poll()).events).toEqual([]);
  state.metadata = [workspace('remote-agent', 'remote-host')];
  const resolved = await world.poll();
  expect(resolved.events).toHaveLength(1);
  expect(resolved.events[0]).toMatchObject({
    kind: 'send',
    fromId: 'local-agent',
    toId: 'remote-agent',
    replay: true,
  });
  expect((await world.poll()).events).toEqual([]);
});

test('terminal screen call history is scoped to its workspace', async () => {
  const { world, state } = setup();
  state.rows.push(workspace('remote-agent', 'remote-host'));
  await world.poll();
  expect(world.callCounts.has('local-agent:shared-terminal')).toBe(true);
  expect(world.callCounts.has('remote-agent:shared-terminal')).toBe(true);
});

for (const allFailed of [false, true]) {
  test(`removed hosts disappear despite another host failure (all failed: ${allFailed})`, async () => {
    const { world, state, source } = setup();
    state.rows.push(
      workspace('failed-agent', 'failed-host'),
      workspace('removed-agent', 'removed-host'),
    );
    await world.poll();
    source.listWorkspaces = async () => ({
      ok: !allFailed,
      error: 'failed host timed out',
      workspaces: allFailed ? [] : [workspace()],
      incompleteHostIds: allFailed ? ['failed-host', 'local-host'] : ['failed-host'],
      authoritativeHostIds: allFailed ? [] : ['local-host'],
      hostListComplete: true,
    });
    const snapshot = await world.poll();
    expect(snapshot.agents.find((agent) => agent.id === 'failed-agent').stale).toBe(true);
    expect(snapshot.agents.some((agent) => agent.id === 'removed-agent')).toBe(false);
    expect(
      snapshot.events.filter((event) => event.kind === 'gone').map((event) => event.toId),
    ).toEqual(['removed-agent']);
  });
}

test('an exited terminal does not freeze a healthy sibling or require its dead screen', async () => {
  const { world, source } = setup();
  source.listTerminals = async () => ({
    ok: true,
    sessions: [
      { terminalId: 'closed', title: 'Claude', exited: true },
      { terminalId: 'running', title: 'Claude', exited: false },
    ],
  });
  const reads = [];
  source.readTerminal = async (_id, terminal) => {
    reads.push(terminal);
    return { ok: true, text: fixtures.spinnerSixPointed };
  };
  const snapshot = await world.poll();
  expect(reads).toEqual(['running']);
  expect(snapshot.agents[0]).toMatchObject({ status: 'working', stale: false });
  expect(snapshot.agents[0].terminals.find((terminal) => terminal.id === 'closed').status).toBe(
    'exited',
  );
});

test('exited remote agents join the bounded idle rotation', async () => {
  const { world, state, source } = setup();
  state.rows = Array.from({ length: 17 }, (_, i) => workspace(`remote-${i}`, 'remote-host'));
  let lists = 0;
  source.listTerminals = async () => {
    lists++;
    return { ok: true, sessions: [{ terminalId: 'closed', title: 'Claude', exited: true }] };
  };
  await world.poll();
  lists = 0;
  for (let i = 0; i < 5; i++) await world.poll();
  expect(lists).toBe(20);
});
