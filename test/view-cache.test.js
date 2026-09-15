import { expect, test } from 'bun:test';
import { ViewCache } from '../public/view-cache.js';

test('a stationary city reuses its plan without freezing animated drawing', () => {
  const cache = new ViewCache();
  const district = {};
  const view = { x0: 0, y0: 0, x1: 100, y1: 100, zoom: 1 };
  let builds = 0;
  const build = () => {
    builds++;
    return [{ draw: (time) => time }];
  };
  const first = cache.read(district, view, build);
  const next = cache.read(district, { ...view }, build);
  expect(builds).toBe(1);
  expect(next).toBe(first);
  expect(first[0].draw(100)).toBe(100);
  expect(next[0].draw(200)).toBe(200);
});

test('panning, zooming, resizing and replacement districts invalidate the visible plan', () => {
  const cache = new ViewCache();
  const district = {};
  const view = { x0: 0, y0: 0, x1: 100, y1: 100, zoom: 1 };
  let builds = 0;
  const build = () => ++builds;
  cache.read(district, view, build);
  for (const key of ['x0', 'y0', 'x1', 'y1', 'zoom']) {
    const before = builds;
    view[key] += 0.00001;
    cache.read(district, view, build);
    expect(builds).toBe(before + 1);
  }
  cache.read({}, view, build);
  expect(builds).toBe(7);
});
