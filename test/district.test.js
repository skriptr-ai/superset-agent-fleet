import { expect, test } from 'bun:test';
import { buildDistrict } from '../public/district.js';

test('an empty startup snapshot has a named restaurant the renderer can draw', () => {
  for (const options of [{}, { houses: [] }, { house: {} }, { houses: [{ name: '' }] }]) {
    const district = buildDistrict(options);
    expect(district.houses).toHaveLength(1);
    expect(district.houses[0].key).toBe('');
    expect(district.houses[0].name.toUpperCase()).toBe('THIS MACHINE');
  }
});

test('named restaurants keep their owner and identity', () => {
  const district = buildDistrict({ houses: [{ key: 'alex', name: 'Alex', seats: 8 }] });
  expect(district.houses[0].name).toBe('Alex');
  expect(district.houses[0].key).toBe('alex');
});
