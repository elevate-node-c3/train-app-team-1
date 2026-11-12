import { describe, expect, it } from 'vitest';

import {
  SEARCH_CACHE_TTL_SECONDS,
  SEARCH_CACHE_TTL_TODAY_SECONDS,
  type CachedStaticTrip,
  cacheTtlSecondsFor,
  isCachedStaticTrip,
  searchCacheKey,
} from './trip-search-cache.js';

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';

const key = (overrides: Partial<Parameters<typeof searchCacheKey>[0]> = {}) =>
  searchCacheKey({
    originStationId: CAIRO,
    destinationStationId: ALEX,
    serviceDate: '2026-06-20',
    travelClassId: FIRST,
    trainNumber: null,
    ...overrides,
  });

const cachedTrip = (): CachedStaticTrip => ({
  tripId: 'trip-1',
  trainNumber: 903,
  trainTypeId: '44444444-4444-4444-8444-444444444444',
  trainTypeEn: 'Express',
  trainTypeAr: 'مميز',
  travelClassNameEn: 'First Class',
  travelClassNameAr: 'الدرجة الأولى',
  originStationId: CAIRO,
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
  farePiastres: 15500,
});

describe('the search cache key', () => {
  it('is stable for the same search', () => {
    expect(key()).toBe(key());
  });

  it('carries a format version, so a shape change is a new key', () => {
    // Otherwise a deploy that changes the stored shape reads yesterday's
    // payload back into today's code.
    expect(key()).toContain(':v2:');
  });

  it('names the catalog search namespace', () => {
    expect(key().startsWith('catalog:search:')).toBe(true);
  });

  // Direction is part of the identity: Banha to Tanta is not the same search
  // as Tanta to Banha, and must not share an answer.
  it('changes when the stations swap', () => {
    expect(key()).not.toBe(
      key({ originStationId: ALEX, destinationStationId: CAIRO }),
    );
  });

  it('changes with the date, the class and the train number', () => {
    expect(key()).not.toBe(key({ serviceDate: '2026-06-21' }));
    expect(key()).not.toBe(key({ travelClassId: CAIRO }));
    expect(key()).not.toBe(key({ trainNumber: 903 }));
  });

  // '*' for absent, which cannot be confused with a train number, because 0 is
  // not a valid one and would otherwise render identically to "any train".
  it('renders an absent train number as a wildcard', () => {
    expect(key({ trainNumber: null }).endsWith(':*')).toBe(true);
    expect(key({ trainNumber: null })).not.toBe(key({ trainNumber: 0 }));
  });
});

describe('the cached payload', () => {
  /**
   * The structural guarantee behind "Sprint 3 changes where availability comes
   * from, not the cache keys": nothing time-dependent is stored at all. If
   * availability or sales state were cached, a later read could serve a stale
   * answer, and the 13:50/14:00 rule would become a thing to remember instead
   * of a property of the design.
   */
  it('stores nothing that depends on the clock or on inventory', () => {
    const stored = Object.keys(cachedTrip());

    for (const forbidden of [
      'availableSeats',
      'soldOut',
      'salesOpen',
      'departed',
      'dateStrip',
      'evaluatedAt',
    ]) {
      expect(stored, `${forbidden} must not be cached`).not.toContain(
        forbidden,
      );
    }
  });

  // Instants are stored as epoch millis, not Date objects: JSON has no date
  // type, so a Date would come back as a string and the eligibility filter
  // compares numbers.
  it('stores instants as numbers that survive a JSON round trip', () => {
    const revived = JSON.parse(
      JSON.stringify(cachedTrip()),
    ) as CachedStaticTrip;

    expect(typeof revived.originDepartureMillis).toBe('number');
    expect(revived.originDepartureMillis).toBe(
      cachedTrip().originDepartureMillis,
    );
  });

  describe('isCachedStaticTrip', () => {
    it('accepts a well-formed payload', () => {
      expect(isCachedStaticTrip(cachedTrip())).toBe(true);
    });

    it('accepts a null fare, which a real trip can have', () => {
      expect(isCachedStaticTrip({ ...cachedTrip(), farePiastres: null })).toBe(
        true,
      );
    });

    // A payload written by an older deploy parses as JSON but is missing a
    // field. Treating it as a hit would put undefined into a response.
    it('rejects a payload missing a field', () => {
      const { durationMinutes, ...incomplete } = cachedTrip();
      void durationMinutes;

      expect(isCachedStaticTrip(incomplete)).toBe(false);
    });

    it('rejects a payload whose instant is a string', () => {
      expect(
        isCachedStaticTrip({
          ...cachedTrip(),
          originDepartureMillis: '2026-06-20T03:00:00Z',
        }),
      ).toBe(false);
    });

    it('rejects anything that is not an object', () => {
      for (const value of [null, undefined, 42, 'trip', []]) {
        expect(isCachedStaticTrip(value)).toBe(false);
      }
    });
  });
});

describe('the cache lifetime', () => {
  const now = new Date('2026-06-15T09:00:00Z'); // 12:00 Cairo on the 15th

  it('is shorter for today than for a future date', () => {
    expect(cacheTtlSecondsFor('2026-06-15', now)).toBe(
      SEARCH_CACHE_TTL_TODAY_SECONDS,
    );
    expect(cacheTtlSecondsFor('2026-06-20', now)).toBe(
      SEARCH_CACHE_TTL_SECONDS,
    );
    expect(SEARCH_CACHE_TTL_TODAY_SECONDS).toBeLessThan(
      SEARCH_CACHE_TTL_SECONDS,
    );
  });

  // Today's list is the one that changes under the traveller: trips keep
  // falling off it as their sales close. The eligibility re-filter already
  // prevents serving a closed trip, so this only bounds how long a
  // disappearing trip lingers.
  it('uses the Cairo date, not the UTC date, to decide what today is', () => {
    const lateUtc = new Date('2026-06-30T22:30:00Z'); // already 1 July in Cairo

    expect(cacheTtlSecondsFor('2026-07-01', lateUtc)).toBe(
      SEARCH_CACHE_TTL_TODAY_SECONDS,
    );
  });
});
