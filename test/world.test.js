// The two pure pieces of the world that need no fleet: matching a create that printed no id
// to the workspace that appeared while it ran, and reading Superset's tag string as folders.

import { describe, expect, test } from 'bun:test';
import { couldHaveMade, spawnsIn, tagsOf } from '../lib/world.js';

const T = (s) => Date.parse(`2026-09-11T10:24:${s}Z`);

describe('spawnsIn', () => {
  test('a workspace born inside the window belongs to the caller', () => {
    const w = { fromId: 'hub', from: T('14.007'), until: T('15.962') };
    const born = new Map([
      ['a', T('15.755')],
      ['b', T('15.810')],
      ['c', T('15.813')],
      ['old', T('00.000') - 3600_000],
    ]);
    const out = spawnsIn([w], born, 0);
    expect([...out.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(out.get('a')).toBe(w);
  });

  test('slack covers clock skew either side, and no further', () => {
    const w = { fromId: 'hub', from: T('14'), until: T('16') };
    const born = new Map([
      ['early', T('11')],
      ['late', T('19')],
      ['far', T('25')],
    ]);
    expect([...spawnsIn([w], born, 3000).keys()].sort()).toEqual(['early', 'late']);
    expect([...spawnsIn([w], born, 0).keys()]).toEqual([]);
  });

  test('two sessions whose windows both cover a birth get nobody', () => {
    const one = { fromId: 'hub1', from: T('14'), until: T('16') };
    const two = { fromId: 'hub2', from: T('15'), until: T('17') };
    const born = new Map([
      ['contested', T('15.5')],
      ['ours', T('16.5')],
    ]);
    const out = spawnsIn([one, two], born, 0);
    expect([...out.keys()]).toEqual(['ours']);
    expect(out.get('ours').fromId).toBe('hub2');
  });

  test('two windows from one session are one claim', () => {
    const a = { fromId: 'hub', from: T('14'), until: T('16') };
    const b = { fromId: 'hub', from: T('15'), until: T('17') };
    expect(spawnsIn([a, b], new Map([['x', T('15.5')]]), 0).get('x')).toBe(a);
  });

  test('a session cannot have made itself, and an unparseable birth is skipped', () => {
    const w = { fromId: 'hub', from: T('14'), until: T('16') };
    const born = new Map([
      ['hub', T('15')],
      ['nan', NaN],
    ]);
    expect(spawnsIn([w], born, 0).size).toBe(0);
  });
});

describe('tagsOf', () => {
  test('reads the comma-separated string Superset lists, trimmed and deduplicated', () => {
    expect(tagsOf({ tags: 'agent-bugs' })).toEqual(['agent-bugs']);
    expect(tagsOf({ tags: ' a , b,a,' })).toEqual(['a', 'b']);
    expect(tagsOf({ tags: '' })).toEqual([]);
    expect(tagsOf({})).toEqual([]);
    expect(tagsOf({ tags: ['x', 'y'] })).toEqual(['x', 'y']);
  });
});

describe('couldHaveMade', () => {
  test('a workspace older than the call was looked at, not made', () => {
    expect(couldHaveMade(T('14'), T('15'))).toBe(true);
    expect(couldHaveMade(T('14'), T('14') - 3600_000)).toBe(false);
  });

  test('clock skew is allowed for, and an unknown birth or time is let through', () => {
    expect(couldHaveMade(T('14'), T('12'), 5000)).toBe(true);
    expect(couldHaveMade(T('14'), T('08'), 5000)).toBe(false);
    expect(couldHaveMade(T('14'), NaN)).toBe(true);
    expect(couldHaveMade(0, T('00'))).toBe(true);
  });
});
