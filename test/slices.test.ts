import { describe, expect, it } from 'vitest';
import { fitsOneCapture, planSegments, planSlices, sliceScale } from '../src/slices.js';

describe('planSegments', () => {
  it('keeps short pages in one segment', () => {
    expect(planSegments(3000, 3, 20_000)).toEqual([{ y: 0, height: 3000 }]);
    expect(fitsOneCapture(5461, 3)).toBe(true);
    expect(fitsOneCapture(5462, 3)).toBe(false); // the field report's iPhone 15 page
  });

  it('covers the page exactly with segments under the device limit', () => {
    const segs = planSegments(21_656, 3);
    expect(segs[0]).toEqual({ y: 0, height: 2730 }); // floor(8192 / 3)
    expect(segs.reduce((h, s) => h + s.height, 0)).toBe(21_656);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.y).toBe(segs[i - 1]!.y + segs[i - 1]!.height);
    for (const s of segs) expect(s.height * 3).toBeLessThanOrEqual(8192);
  });

  it('picks segment heights that are whole device pixels at fractional DPRs', () => {
    for (const dpr of [2.625, 3.5, 1.5, 1.25]) {
      const segs = planSegments(30_000, dpr);
      for (const s of segs.slice(0, -1)) {
        expect(Number.isInteger(s.height * dpr), `${dpr} x ${s.height}`).toBe(true);
        expect(s.height * dpr).toBeLessThanOrEqual(8192);
      }
    }
    expect(planSegments(30_000, 2.625)[0]!.height).toBe(3120); // multiple of 8
  });
});

describe('planSlices', () => {
  it('cuts one viewport per slice with labels', () => {
    const s = planSlices('iphone-15', 852 * 7, 852);
    expect(s).toHaveLength(7);
    expect(s[1]).toEqual({
      y: 852,
      height: 852,
      index: 2,
      total: 7,
      label: 'iphone-15 · slice 2/7 · y=852–1704 css px',
    });
    expect(s[6]!.y + s[6]!.height).toBe(852 * 7);
  });

  it('keeps a real remainder as its own slice', () => {
    const s = planSlices('ipad', 2000, 900);
    expect(s.map(x => [x.y, x.height])).toEqual([[0, 900], [900, 900], [1800, 200]]);
  });

  it('folds a sliver into the previous slice', () => {
    const s = planSlices('desktop-1440', 1850, 900);
    expect(s.map(x => [x.y, x.height])).toEqual([[0, 900], [900, 950]]);
    expect(s[1]!.label).toBe('desktop-1440 · slice 2/2 · y=900–1850 css px');
  });

  it('a page shorter than a slice is one slice', () => {
    expect(planSlices('x', 400, 852)).toHaveLength(1);
  });
});

describe('sliceScale', () => {
  it('caps width and never upsamples past the DPR', () => {
    expect(393 * sliceScale(393, 3, 768)).toBeCloseTo(768);
    expect(sliceScale(1440, 1, 768)).toBeCloseTo(0.5333, 3);
    expect(sliceScale(320, 1, 768)).toBe(1);
  });
});
