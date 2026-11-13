import { describe, it, expect } from 'vitest';
import { overlaps, segmentOf, toInt4Range, parseInt4Range, stationsInUse } from './segment.js';

describe('overlaps', () => {
  // Positions on the Cairo -> Alexandria train: Ramsis 0, Banha 1, Tanta 2,
  // Damnhour 3, Sidi Gaber 4, ElRaml 5.
  it('lets touching segments share a seat', () => {
    expect(overlaps(segmentOf(0, 2), segmentOf(2, 5))).toBe(false);
  });

  it('refuses a segment enclosed by another', () => {
    expect(overlaps(segmentOf(0, 5), segmentOf(1, 2))).toBe(true);
  });

  it('agrees with i1 < j2 && i2 < j1 for every pair on a six-stop trip', () => {
    const all = [];
    for (let i = 0; i <= 5; i += 1)
      for (let j = i + 1; j <= 5; j += 1) all.push(segmentOf(i, j));
    expect(all).toHaveLength(15);

    for (const a of all)
      for (const b of all)
        expect(overlaps(a, b)).toBe(a.from < b.to && b.from < a.to);
  });
});

describe('segmentOf', () => {
  it('refuses a destination before its origin', () => {
    expect(() => segmentOf(4, 1)).toThrow(RangeError);
  });

  it('refuses the same station twice', () => {
    expect(() => segmentOf(2, 2)).toThrow(RangeError);
  });

  it('accepts a two-stop trip', () => {
    expect(segmentOf(0, 1)).toEqual({ from: 0, to: 1 });
  });
});

describe('int4range encoding', () => {
  it('writes a half-open literal', () => {
    expect(toInt4Range(segmentOf(0, 2))).toBe('[0,2)');
  });

  it('round-trips what Postgres returns', () => {
    expect(parseInt4Range('[0,2)')).toEqual({ from: 0, to: 2 });
  });

  it('reads an inclusive upper bound Postgres may normalise to', () => {
    expect(parseInt4Range('[0,2]')).toEqual({ from: 0, to: 3 });
  });
});

describe('stationsInUse', () => {
  it('includes the station the passenger alights at', () => {
    expect(stationsInUse(segmentOf(0, 2))).toEqual([0, 1, 2]);
  });
});
