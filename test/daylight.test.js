// The sun over Oslo, checked against the almanac: the picture's day and night hang off this.

import { describe, expect, test } from 'bun:test';
import { sunElevation, lightAt, shadeColor } from '../public/daylight.js';

const OSLO = { name: 'Oslo', tz: 'Europe/Oslo', lat: 59.9139, lon: 10.7522 };

describe('sunElevation', () => {
  // timeanddate.com for Oslo, 11 September 2026: sunrise 06:41, solar noon 13:13 at 34.6°,
  // sunset 19:43 (CEST, UTC+2).
  test('a September morning in Oslo is well up', () => {
    const el = sunElevation(new Date('2026-09-11T08:26:00Z'), OSLO.lat, OSLO.lon);
    expect(el).toBeGreaterThan(24);
    expect(el).toBeLessThan(29);
  });
  test('solar noon in September reaches the almanac height', () => {
    const el = sunElevation(new Date('2026-09-11T11:13:00Z'), OSLO.lat, OSLO.lon);
    expect(Math.abs(el - 34.6)).toBeLessThan(1);
  });
  test('sunrise and sunset sit on the horizon', () => {
    for (const iso of ['2026-09-11T04:41:00Z', '2026-09-11T17:43:00Z']) {
      const el = sunElevation(new Date(iso), OSLO.lat, OSLO.lon);
      expect(Math.abs(el)).toBeLessThan(1.5);
    }
  });
  test('a December afternoon is already dusk, and a June midnight is not full night', () => {
    expect(sunElevation(new Date('2026-12-21T15:30:00Z'), OSLO.lat, OSLO.lon)).toBeLessThan(-6);
    // Midsummer in Oslo: the sun dips only a few degrees under.
    expect(sunElevation(new Date('2026-06-21T23:00:00Z'), OSLO.lat, OSLO.lon)).toBeGreaterThan(-8);
  });
});

describe('lightAt', () => {
  test('ten in the morning is day with the lamps off', () => {
    const light = lightAt(new Date('2026-09-11T08:26:00Z'), OSLO);
    expect(light.day).toBe(1);
    expect(light.lamps).toBe(0);
  });
  test('eleven at night is night with the lamps on', () => {
    const light = lightAt(new Date('2026-09-11T21:00:00Z'), OSLO);
    expect(light.day).toBe(0);
    expect(light.lamps).toBe(1);
  });
  test('cloud dims the day but never makes a night of it', () => {
    const light = lightAt(new Date('2026-09-11T08:26:00Z'), OSLO, { cloud: 1 });
    expect(light.day).toBeGreaterThan(0.5);
    expect(light.day).toBeLessThan(1);
    expect(light.lamps).toBe(0);
  });
});

describe('shadeColor', () => {
  const night = lightAt(new Date('2026-09-11T21:00:00Z'), OSLO);
  const day = lightAt(new Date('2026-09-11T08:26:00Z'), OSLO);
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\d+/g).map(Number);
    return (r + g + b) / 3;
  };
  test('night leaves the palette as it was', () => {
    expect(shadeColor('#3a4148', night)).toBe('rgb(58,65,72)');
  });
  test('day lifts the ground far more than an outline', () => {
    expect(lum(shadeColor('#3a4148', day))).toBeGreaterThan(120); // the yard
    expect(lum(shadeColor('#1e1a1a', day))).toBeLessThan(60); // a figure's outline
  });
  test('alpha rides through, and a gradient object is left alone', () => {
    expect(shadeColor('rgba(12,16,24,0.55)', day)).toMatch(/^rgba\(\d+,\d+,\d+,0\.55\)$/);
    const gradient = { addColorStop() {} };
    expect(shadeColor(gradient, day)).toBe(gradient);
  });
});
