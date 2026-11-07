import type { SearchSort } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { sortTrips, type SortableTrip } from './trip-search-sort.js';

const at = (minutes: number): number =>
  Date.parse('2026-11-10T00:00:00Z') + minutes * 60_000;

const trip = (overrides: Partial<SortableTrip> = {}): SortableTrip => ({
  tripId: '11111111-1111-4111-8111-111111111111',
  trainNumber: 903,
  originDepartureMillis: at(8 * 60),
  destinationArrivalMillis: at(10 * 60),
  durationMinutes: 120,
  farePiastres: 5_000,
  ...overrides,
});

const idsOf = (trips: readonly SortableTrip[]): string[] =>
  trips.map((candidate) => candidate.tripId);

describe('ordering the search results', () => {
  it('defaults to departure ascending, the mandated order', () => {
    const late = trip({ tripId: 'late', originDepartureMillis: at(18 * 60) });
    const early = trip({ tripId: 'early', originDepartureMillis: at(6 * 60) });

    expect(idsOf(sortTrips([late, early], undefined))).toEqual([
      'early',
      'late',
    ]);
    expect(idsOf(sortTrips([late, early], 'SEARCH_SORT_UNSPECIFIED'))).toEqual([
      'early',
      'late',
    ]);
    expect(
      idsOf(sortTrips([late, early], 'SEARCH_SORT_DEPARTURE_ASC')),
    ).toEqual(['early', 'late']);
  });

  it('falls back to departure ascending for an order it does not know', () => {
    // An older server must not reject a newer client's order.
    const late = trip({ tripId: 'late', originDepartureMillis: at(18 * 60) });
    const early = trip({ tripId: 'early', originDepartureMillis: at(6 * 60) });

    expect(
      idsOf(
        sortTrips(
          [late, early],
          'SEARCH_SORT_DEPARTS_AFTER_NOON' as SearchSort,
        ),
      ),
    ).toEqual(['early', 'late']);
  });

  it('orders by duration, tie-breaking on departure', () => {
    const slow = trip({ tripId: 'slow', durationMinutes: 200 });
    const fast = trip({
      tripId: 'fast',
      durationMinutes: 90,
      originDepartureMillis: at(18 * 60),
    });
    const sameDurationEarlier = trip({
      tripId: 'same-duration-earlier',
      durationMinutes: 200,
      originDepartureMillis: at(7 * 60),
    });

    expect(
      idsOf(
        sortTrips(
          [slow, fast, sameDurationEarlier],
          'SEARCH_SORT_DURATION_ASC',
        ),
      ),
    ).toEqual(['fast', 'same-duration-earlier', 'slow']);
  });

  it('orders by fare, tie-breaking on departure', () => {
    const expensive = trip({ tripId: 'expensive', farePiastres: 15_000 });
    const cheap = trip({
      tripId: 'cheap',
      farePiastres: 3_000,
      originDepartureMillis: at(18 * 60),
    });
    const sameFareEarlier = trip({
      tripId: 'same-fare-earlier',
      farePiastres: 15_000,
      originDepartureMillis: at(7 * 60),
    });

    expect(
      idsOf(
        sortTrips([expensive, cheap, sameFareEarlier], 'SEARCH_SORT_FARE_ASC'),
      ),
    ).toEqual(['cheap', 'same-fare-earlier', 'expensive']);
  });

  it('orders by arrival, tie-breaking on departure', () => {
    const arrivesLate = trip({
      tripId: 'arrives-late',
      destinationArrivalMillis: at(22 * 60),
    });
    const arrivesEarly = trip({
      tripId: 'arrives-early',
      destinationArrivalMillis: at(12 * 60),
      originDepartureMillis: at(9 * 60),
    });
    const sameArrivalEarlier = trip({
      tripId: 'same-arrival-earlier',
      destinationArrivalMillis: at(12 * 60),
      originDepartureMillis: at(8 * 60),
    });

    expect(
      idsOf(
        sortTrips(
          [arrivesLate, arrivesEarly, sameArrivalEarlier],
          'SEARCH_SORT_ARRIVAL_ASC',
        ),
      ),
    ).toEqual(['same-arrival-earlier', 'arrives-early', 'arrives-late']);
  });

  it('breaks a departure tie on train number, then trip id', () => {
    const second = trip({
      tripId: 'second',
      trainNumber: 904,
      originDepartureMillis: at(8 * 60),
    });
    const first = trip({
      tripId: 'first',
      trainNumber: 903,
      originDepartureMillis: at(8 * 60),
    });

    expect(idsOf(sortTrips([second, first], undefined))).toEqual([
      'first',
      'second',
    ]);
  });

  it('does not reorder its input', () => {
    const late = trip({ tripId: 'late', originDepartureMillis: at(18 * 60) });
    const early = trip({
      tripId: 'early',
      originDepartureMillis: at(6 * 60),
    });
    const input = [late, early];

    sortTrips(input, 'SEARCH_SORT_DEPARTURE_ASC');

    expect(idsOf(input)).toEqual(['late', 'early']);
  });
});
