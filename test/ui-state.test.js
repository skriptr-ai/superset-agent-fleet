import { expect, test } from 'bun:test';
import { connectionState, validSnapshot } from '../public/ui-state.js';
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
