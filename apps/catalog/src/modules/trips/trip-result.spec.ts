import { describe, expect, it, vi } from 'vitest';

import { buildTripList, toTripResult } from './trip-result.js';
import type { CachedStaticTrip } from './trip-search-cache.js';

/** Both search legs must share filter and sort rules. */

const RAMSIS = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';
const EXPRESS = '44444444-4444-4444-8444-444444444444';
const SLEEPER = '55555555-5555-4555-8555-555555555555';

function trip(overrides: Partial<CachedStaticTrip> = {}): CachedStaticTrip {
  return {
    tripId: 'trip-1',
    trainNumber: 903,
    trainTypeId: EXPRESS,
    trainTypeEn: 'Express',
    trainTypeAr: 'مميز',
    travelClassNameEn: 'First Class',
    travelClassNameAr: 'الدرجة الأولى',
    originStationId: RAMSIS,
    originNameEn: 'Ramsis',
    originNameAr: 'رمسيس',
    destinationStationId: ALEX,
    destinationNameEn: 'Misr Station',
    destinationNameAr: 'محطة مصر',
    originDepartureMillis: Date.parse('2026-06-20T03:00:00Z'),
    destinationArrivalMillis: Date.parse('2026-06-20T05:40:00Z'),
    durationMinutes: 160,
    intermediateStops: 2,
    classCapacity: 40,
    farePiastres: 15_500,
    ...overrides,
  };
}

const seatsFor = (...entries: [string, number][]): Map<string, number> =>
  new Map(entries);

describe('building the trip list', () => {
  it('maps, orders and counts what survived the filters', () => {
    const list = buildTripList({
      eligible: [
        trip({
          tripId: 'late',
          originDepartureMillis: Date.parse('2026-06-20T09:00:00Z'),
        }),
        trip({
          tripId: 'early',
          originDepartureMillis: Date.parse('2026-06-20T03:00:00Z'),
        }),
      ],
      seats: seatsFor(['late', 10], ['early', 10]),
      travelClassId: FIRST,
    });

    expect(list.trips.map((result) => result.tripId)).toEqual([
      'early',
      'late',
    ]);
    expect(list.filteredCount).toBe(2);
  });

  /**
   * Keep filter survivors separate from priced results; unpriced trips must not
   * make an empty result blame filters.
   */
  it('counts filter survivors, not priced survivors', () => {
    const list = buildTripList({
      eligible: [trip({ tripId: 'unpriced', farePiastres: null })],
      seats: seatsFor(['unpriced', 10]),
      travelClassId: FIRST,
    });

    expect(list.trips).toEqual([]);
    // Unpriced removal is not a filter-empty result.
    expect(list.filteredCount).toBe(1);
  });

  it('reports every unpriced trip it drops', () => {
    const onUnpriced = vi.fn();

    buildTripList({
      eligible: [
        trip({ tripId: 'priced' }),
        trip({ tripId: 'unpriced', farePiastres: null }),
      ],
      seats: seatsFor(['priced', 10], ['unpriced', 10]),
      travelClassId: FIRST,
      onUnpriced,
    });

    expect(onUnpriced).toHaveBeenCalledTimes(1);
    expect(onUnpriced.mock.calls[0][0].tripId).toBe('unpriced');
  });

  // Reuse the response's seat counts for sold-out filters; no extra query.
  it('hides sold-out trips from the seats it was given, only when asked', () => {
    const eligible = [trip({ tripId: 'open' }), trip({ tripId: 'full' })];
    const seats = seatsFor(['open', 10], ['full', 0]);

    const shown = buildTripList({ eligible, seats, travelClassId: FIRST });
    const hidden = buildTripList({
      eligible,
      seats,
      travelClassId: FIRST,
      filters: { excludeSoldOut: true },
    });

    // Equal departure and train number require the tripId tie-break.
    expect(shown.trips.map((result) => result.tripId)).toEqual([
      'full',
      'open',
    ]);
    expect(hidden.trips.map((result) => result.tripId)).toEqual(['open']);
  });

  it('narrows by train type and fare before ordering', () => {
    const list = buildTripList({
      eligible: [
        trip({ tripId: 'express', trainTypeId: EXPRESS, farePiastres: 20_000 }),
        trip({ tripId: 'sleeper', trainTypeId: SLEEPER, farePiastres: 9_000 }),
      ],
      seats: seatsFor(['express', 10], ['sleeper', 10]),
      travelClassId: FIRST,
      filters: { trainTypeIds: [SLEEPER] },
      sort: 'SEARCH_SORT_FARE_ASC',
    });

    expect(list.trips.map((result) => result.tripId)).toEqual(['sleeper']);
  });
});

describe('one trip on the wire', () => {
  it('carries the class the traveller asked for, not the trip', () => {
    const result = toTripResult(trip(), FIRST, 40);

    expect(result.travelClass.id).toBe(FIRST);
    expect(result.travelClass.name.en).toBe('First Class');
  });

  it('prints Cairo wall-clock times at both endpoints', () => {
    const result = toTripResult(trip(), FIRST, 40);

    // 03:00Z in June is 06:00 Cairo, and the offset travels with it.
    expect(result.departure.at.localTime).toBe('06:00');
    expect(result.departure.at.utcOffset).toBe('+03:00');
    expect(result.arrival.at.localTime).toBe('08:40');
  });

  // Sold-out trips are returned and marked, never hidden.
  it('marks a trip with no seats as sold out rather than dropping it', () => {
    expect(toTripResult(trip(), FIRST, 0).soldOut).toBe(true);
    expect(toTripResult(trip(), FIRST, 1).soldOut).toBe(false);
  });

  it('reports the fare in piastres, excluding the booking fee', () => {
    const result = toTripResult(trip({ farePiastres: 15_500 }), FIRST, 40);

    expect(result.fare).toEqual({ amountMinor: 15_500, currency: 'EGP' });
  });
});
