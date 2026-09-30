import { expect, test } from 'bun:test';
import { connectionState, isLiveEvent, LIVE_EVENT_MS, validSnapshot } from '../public/ui-state.js';
import { demoWorld } from '../demo/data.js';

test('a failed source does not describe healthy visible agents as a total outage', () => {
  expect(connectionState({ count: 8, errors: true, healthy: 1, received: true })).toBe('partial');
  expect(connectionState({ count: 0, errors: true, healthy: 0, received: true })).toBe(
    'unavailable',
  );
});

test('an interrupted stream marks retained agents stale until another snapshot arrives', () => {
  expect(connectionState({ count: 8, reconnecting: true, healthy: 0, received: true })).toBe(
    'stale',
  );
  expect(connectionState({ count: 8, healthy: 1, received: true })).toBe('live');
});

test('an empty connected source differs from one that has not connected', () => {
  expect(connectionState({})).toBe('connecting');
  expect(connectionState({ received: true, healthy: 1 })).toBe('empty');
});

test('bad stream data is rejected before it can replace the visible world', () => {
  expect(validSnapshot(null)).toBe(false);
  expect(validSnapshot({ agents: {} })).toBe(false);
  expect(validSnapshot({ agents: [{ id: 'missing-terminal-data' }] })).toBe(false);
  expect(validSnapshot({ agents: [], events: [null] })).toBe(false);
  expect(validSnapshot({ agents: [], links: [null] })).toBe(false);
  expect(validSnapshot({ agents: [], events: [] })).toBe(true);
  expect(validSnapshot({ ...demoWorld(), sourceKey: 'fixture-host' })).toBe(true);
});

test('a backlog replayed by the cloud does not speak a day-old reply over an idle session', () => {
  // An idle session's last word, pushed a day and a half ago and still in its machine's
  // backlog when the cloud stream reconnected.
  const snapshotAt = Date.parse('2026-09-30T17:06:00Z');
  const old = {
    id: 'alex-laptop:7200',
    kind: 'report',
    at: Date.parse('2026-09-29T06:00:08Z'),
  };
  expect(isLiveEvent(old, snapshotAt)).toBe(false);
  expect(isLiveEvent({ ...old, at: snapshotAt - 2_000 }, snapshotAt)).toBe(true);
  expect(isLiveEvent({ ...old, at: snapshotAt - LIVE_EVENT_MS - 1 }, snapshotAt)).toBe(false);
});

test('replays and undated events are never played out', () => {
  const snapshotAt = 1_790_000_000_000;
  expect(isLiveEvent({ kind: 'send', at: snapshotAt, replay: true }, snapshotAt)).toBe(false);
  expect(isLiveEvent({ kind: 'send', at: 0 }, snapshotAt)).toBe(false);
  expect(isLiveEvent({ kind: 'send' }, snapshotAt)).toBe(false);
});

test('an event is judged by its own machine clock, not the browser one', () => {
  // A machine whose clock runs an hour behind the browser still has its live events played.
  const hostNow = Date.now() - 3_600_000;
  expect(isLiveEvent({ kind: 'report', at: hostNow - 1_000 }, hostNow)).toBe(true);
});

test('the demo keeps playing its live ticks', () => {
  for (const tick of [2, 3, 4]) {
    const world = demoWorld({ tick });
    const live = world.events.filter((e) => e.id.includes('-live-'));
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((event) => isLiveEvent(event, world.at))).toBe(true);
  }
});
