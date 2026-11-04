import { describe, expect, it } from 'vitest';

import {
  MAX_TRIP_DAY_SPAN_DAYS,
  SALES_CLOSE_LEAD_MINUTES,
  SELLABLE_TRIP_STATUSES,
  applyDynamicEligibility,
  isSellableAt,
  salesCloseAt,
} from './trip-sellability.js';

const DEPARTURE = new Date('2026-06-15T11:00:00Z').getTime(); // 14:00 Cairo
const MINUTE = 60_000;

describe('when sales close', () => {
  it('closes them 15 minutes before the origin departure', () => {
    expect(SALES_CLOSE_LEAD_MINUTES).toBe(15);
    expect(salesCloseAt(DEPARTURE)).toBe(DEPARTURE - 15 * MINUTE);
  });

  // The rule says "exactly 15 minutes before is closed", so the boundary is
  // pinned to the millisecond rather than to the minute. An implementation
  // using <= here would sell a seat the rule forbids.
  it('is open one millisecond before the boundary', () => {
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE - 15 * MINUTE - 1))).toBe(
      true,
    );
  });

  it('is CLOSED exactly 15 minutes before', () => {
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE - 15 * MINUTE))).toBe(
      false,
    );
  });

  it('is closed between the boundary and the departure', () => {
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE - 14 * MINUTE))).toBe(
      false,
    );
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE - 1))).toBe(false);
  });

  // "Not departed" needs no rule of its own: it is strictly weaker than
  // sales-closed, so one predicate enforces both.
  it('is closed at and after the departure itself', () => {
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE))).toBe(false);
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE + 60 * MINUTE))).toBe(
      false,
    );
  });

  it('is open well ahead of the departure', () => {
    expect(isSellableAt(DEPARTURE, new Date(DEPARTURE - 16 * MINUTE))).toBe(
      true,
    );
    expect(
      isSellableAt(DEPARTURE, new Date(DEPARTURE - 10 * 24 * 60 * MINUTE)),
    ).toBe(true);
  });
});

describe('applyDynamicEligibility', () => {
  const rows = [
    { tripId: 'departed', originDepartureMillis: DEPARTURE - 10 * MINUTE },
    { tripId: 'closing-now', originDepartureMillis: DEPARTURE + 15 * MINUTE },
    { tripId: 'open', originDepartureMillis: DEPARTURE + 60 * MINUTE },
  ];

  it('keeps only the trips still on sale', () => {
    const kept = applyDynamicEligibility(rows, new Date(DEPARTURE));

    expect(kept.map((row) => row.tripId)).toEqual(['open']);
  });

  it('preserves the order it was given', () => {
    const kept = applyDynamicEligibility(
      rows,
      new Date(DEPARTURE - 60 * MINUTE),
    );

    expect(kept.map((row) => row.tripId)).toEqual([
      'departed',
      'closing-now',
      'open',
    ]);
  });

  it('does not mutate its input', () => {
    const before = rows.length;
    applyDynamicEligibility(rows, new Date(DEPARTURE));

    expect(rows).toHaveLength(before);
  });

  // This is the property the cache depends on: the filter is a function of
  // `now` alone, so re-running it on a cached list at a later instant drops
  // whatever has since closed.
  it('drops more trips as now advances over the same list', () => {
    const counts = [
      DEPARTURE - 120 * MINUTE,
      DEPARTURE,
      DEPARTURE + 60 * MINUTE,
    ].map((instant) => applyDynamicEligibility(rows, new Date(instant)).length);

    expect(counts).toEqual([3, 1, 0]);
  });
});

describe('the sellable statuses', () => {
  it('counts only published trips as sellable', () => {
    expect([...SELLABLE_TRIP_STATUSES]).toEqual(['published']);
  });

  it('is the one place a fourth status would have to be added', () => {
    // dated_trip has no 'cancelled' value: draft and withdrawn are both
    // not-sellable, and withdrawn is what an operator sets to pull a service.
    // Centralizing it means the day cancelled arrives, one line changes.
    for (const notSellable of ['draft', 'withdrawn']) {
      expect(SELLABLE_TRIP_STATUSES).not.toContain(notSellable);
    }
  });
});

describe('the trip day span', () => {
  it('reaches at least one day back, for overnight services', () => {
    // A trip whose service_date is D can depart the passenger's origin on
    // D+1, so the SQL's pruning range must look back this far. Understating
    // it loses overnight trips silently -- which is why it is a named
    // constant with a guard rather than a literal in the query.
    expect(MAX_TRIP_DAY_SPAN_DAYS).toBeGreaterThanOrEqual(1);
  });
});
