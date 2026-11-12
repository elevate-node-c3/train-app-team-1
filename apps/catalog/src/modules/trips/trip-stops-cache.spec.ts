import { describe, expect, it } from 'vitest';

import {
  TRIP_STOPS_TTL_JITTER_FRACTION,
  TRIP_STOPS_TTL_SECONDS,
  type CachedTripStop,
  isCachedTripStop,
  jitteredTtlSeconds,
  tripStopsCacheKey,
} from './trip-stops-cache.js';

const TRIP = '11111111-1111-4111-8111-111111111111';
const CAIRO = '22222222-2222-4222-8222-222222222222';
const ALEX = '33333333-3333-4333-8333-333333333333';

const key = (
  overrides: Partial<Parameters<typeof tripStopsCacheKey>[0]> = {},
): string =>
  tripStopsCacheKey({
    tripId: TRIP,
    originStationId: CAIRO,
    destinationStationId: ALEX,
    ...overrides,
  });

const stop = (): CachedTripStop => ({
  stationId: CAIRO,
  stationNameEn: 'Ramsis',
  stationNameAr: 'رمسيس',
  arrivalMillis: null,
  departureMillis: Date.parse('2026-06-20T03:00:00Z'),
});

describe('the trip-stops cache key', () => {
  it('names the resource and a format version', () => {
    expect(key()).toBe(`catalog:trip-stops:v1:${TRIP}:${CAIRO}:${ALEX}`);
  });

  it('changes with the trip, the boarding stop and the alighting stop', () => {
    expect(key()).not.toBe(key({ tripId: 'another-trip' }));
    expect(key()).not.toBe(key({ originStationId: ALEX }));
    expect(key()).not.toBe(key({ destinationStationId: CAIRO }));
  });

  // Reverse pairs describe different segments and must not share cache entries.
  it('distinguishes the two travel directions', () => {
    expect(key()).not.toBe(
      key({ originStationId: ALEX, destinationStationId: CAIRO }),
    );
  });
});

describe('the trip-stops cache lifetime', () => {
  it('is six hours within a ten-percent jitter band', () => {
    const low = jitteredTtlSeconds(
      TRIP_STOPS_TTL_SECONDS,
      TRIP_STOPS_TTL_JITTER_FRACTION,
      () => 0,
    );
    const nominal = jitteredTtlSeconds(
      TRIP_STOPS_TTL_SECONDS,
      TRIP_STOPS_TTL_JITTER_FRACTION,
      () => 0.5,
    );
    const high = jitteredTtlSeconds(
      TRIP_STOPS_TTL_SECONDS,
      TRIP_STOPS_TTL_JITTER_FRACTION,
      () => 1,
    );

    expect(nominal).toBe(TRIP_STOPS_TTL_SECONDS);
    expect(low).toBe(Math.round(TRIP_STOPS_TTL_SECONDS * 0.9));
    expect(high).toBe(Math.round(TRIP_STOPS_TTL_SECONDS * 1.1));
    expect(low).toBeLessThan(nominal);
    expect(nominal).toBeLessThan(high);
  });

  it('never returns a non-positive lifetime', () => {
    expect(jitteredTtlSeconds(1, 2, () => 0)).toBe(1);
  });
});

describe('the cached stop payload', () => {
  it('accepts a well-formed stop, including a null endpoint time', () => {
    expect(isCachedTripStop(stop())).toBe(true);
    expect(
      isCachedTripStop({
        ...stop(),
        arrivalMillis: Date.parse('2026-06-20T02:55:00Z'),
        departureMillis: null,
      }),
    ).toBe(true);
  });

  it('rejects a payload missing a field', () => {
    const { stationNameAr, ...incomplete } = stop();
    void stationNameAr;

    expect(isCachedTripStop(incomplete)).toBe(false);
  });

  it('rejects a payload whose instant is a string', () => {
    expect(
      isCachedTripStop({
        ...stop(),
        departureMillis: '2026-06-20T03:00:00Z',
      }),
    ).toBe(false);
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 42, 'stop', []]) {
      expect(isCachedTripStop(value)).toBe(false);
    }
  });
});
