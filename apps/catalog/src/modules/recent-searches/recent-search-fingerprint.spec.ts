import { describe, expect, it } from 'vitest';

import { fingerprintOf } from './recent-search-fingerprint.js';
import type { RecentSearchInput } from './recent-searches.types.js';

/**
 * What counts as the same search (BR-21).
 *
 * This function alone decides whether a traveller's five slots fill up with
 * near-duplicates or stay the five journeys they actually look for, so each
 * rule below is one of the story's sentences.
 */

const RAMSIS = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const TANTA = '33333333-3333-4333-8333-333333333333';
const FIRST = '44444444-4444-4444-8444-444444444444';
const SECOND = '55555555-5555-4555-8555-555555555555';

const search = (
  overrides: Partial<RecentSearchInput> = {},
): RecentSearchInput => ({
  accountId: '66666666-6666-4666-8666-666666666666',
  originStationId: RAMSIS,
  destinationStationId: ALEX,
  travelClassId: FIRST,
  kind: 'one_way',
  trainNumber: null,
  departureDate: '2026-06-20',
  returnDate: null,
  ...overrides,
});

describe('the recent-search fingerprint', () => {
  it('is the same for an identical search', () => {
    expect(fingerprintOf(search())).toBe(fingerprintOf(search()));
  });

  /**
   * The story's "repeating one moves it to the top with its new dates": if
   * dates were part of identity, the sixth search of one route would evict the
   * first instead of refreshing it.
   */
  it('ignores the dates, so the same route repeats rather than duplicates', () => {
    expect(fingerprintOf(search({ departureDate: '2026-07-01' }))).toBe(
      fingerprintOf(search({ departureDate: '2026-06-20' })),
    );
    expect(fingerprintOf(search({ returnDate: '2026-07-05' }))).toBe(
      fingerprintOf(search({ returnDate: null })),
    );
  });

  it('separates a round trip from a one-way on the same route', () => {
    expect(fingerprintOf(search({ kind: 'round_trip' }))).not.toBe(
      fingerprintOf(search({ kind: 'one_way' })),
    );
  });

  it('separates the two directions of a route', () => {
    expect(
      fingerprintOf(
        search({ originStationId: ALEX, destinationStationId: RAMSIS }),
      ),
    ).not.toBe(fingerprintOf(search()));
  });

  it('separates a different destination, class or train number', () => {
    const base = fingerprintOf(search());

    expect(fingerprintOf(search({ destinationStationId: TANTA }))).not.toBe(
      base,
    );
    expect(fingerprintOf(search({ travelClassId: SECOND }))).not.toBe(base);
    expect(fingerprintOf(search({ trainNumber: 903 }))).not.toBe(base);
  });

  // '*' rather than an empty segment, so "any train" cannot collide with a
  // train number or produce two adjacent colons.
  it('spells an absent train number without an empty segment', () => {
    const anyTrain = fingerprintOf(search({ trainNumber: null }));

    expect(anyTrain.endsWith(':*')).toBe(true);
    expect(anyTrain).not.toContain('::');
  });

  describe('the five-slot behaviour it produces', () => {
    const distinct = (searches: RecentSearchInput[]): number =>
      new Set(searches.map((one) => fingerprintOf(one))).size;

    it('collapses the same search repeated six times into one', () => {
      const repeated = Array.from({ length: 6 }, (_, index) =>
        search({ departureDate: `2026-06-2${index}` }),
      );

      expect(distinct(repeated)).toBe(1);
    });

    it('keeps six genuinely different searches apart', () => {
      const stations = [RAMSIS, ALEX, TANTA];
      const different = [
        search(),
        search({ destinationStationId: TANTA }),
        search({ travelClassId: SECOND }),
        search({ kind: 'round_trip' }),
        search({ trainNumber: 903 }),
        search({ originStationId: stations[1], destinationStationId: TANTA }),
      ];

      expect(distinct(different)).toBe(6);
    });
  });
});
