import { describe, expect, it } from 'vitest';
import { seriesToElectrodeData, scalaTag, scalaName } from '../electrodeData';

// An auto-process result is fetched after EVERY step, so the electrode dock sees a payload with
// no lead yet (before 'Search for electrodes'). A missing `series` threw here, which unmounted
// React and left a blank page — these pin the empty cases.
describe('seriesToElectrodeData', () => {
  it('survives a mid-run result whose series is absent', () => {
    expect(() => seriesToElectrodeData(undefined)).not.toThrow();
    const d = seriesToElectrodeData(undefined);
    expect(Object.keys(d.min_dist)).toHaveLength(0);
    expect(Object.keys(d.location)).toHaveLength(0);
  });

  it('survives the empty series the backend sends when there is no lead', () => {
    const empty = { number: [], label: [], place_freq: [], channel_freq: [], angle: [], distance: [] };
    expect(seriesToElectrodeData(empty).location).toEqual({});
  });

  it('maps a populated series by electrode number', () => {
    const s = {
      number: [1, 2],
      label: [22, 21],
      place_freq: [710, 781],
      channel_freq: [251, 320],
      angle: [376.1, 342.9],
      distance: [0.03, 0.11],
    };
    const d = seriesToElectrodeData(s, [1, 2]);
    expect(d.min_freq['22']).toBe(710);
    expect(d.angle['21']).toBe(342.9);
    expect(d.location['22']).toBe('Scala Tympani');
    expect(d.location['21']).toBe('Scala Vestibuli');
  });

  it('drops non-finite values rather than charting them', () => {
    const s = {
      number: [1],
      label: [5],
      place_freq: [null],
      channel_freq: [NaN],
      angle: [12],
      distance: [null],
    };
    const d = seriesToElectrodeData(s, [null]);
    expect(d.min_freq['5']).toBeUndefined();
    expect(d.c_freq['5']).toBeUndefined();
    expect(d.angle['5']).toBe(12);
    // location keys the charts' electrode set, so every electrode still needs an entry
    expect(d.location['5']).toBe('Out of Cochlea');
  });
});

describe('scala labels', () => {
  it('maps the codes the desktop uses', () => {
    expect([0, 1, 2, 3].map(scalaTag)).toEqual(['OC', 'ST', 'SV', 'BM']);
    expect(scalaName(1)).toBe('Scala Tympani');
    expect(scalaTag(null)).toBe('');
    expect(scalaName(undefined)).toBe('');
  });
});
