import { ACCESS_LEVEL_KEY, RATE_LIMIT_KEY } from '@app/common';
import { describe, expect, it, vi } from 'vitest';

import { CatalogController } from './catalog.controller.js';
import type { CatalogService } from './catalog.service.js';
import type { RecentSearchesQueryDto } from './dto/recent-searches.dto.js';
import type { SearchReturnTripsDto } from './dto/search-return-trips.dto.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';
import type { TripStopsQueryDto } from './dto/trip-stops.dto.js';

const query = {
  from: '11111111-1111-4111-8111-111111111111',
  to: '22222222-2222-4222-8222-222222222222',
  departureDate: '2026-06-20',
  travelClassId: '33333333-3333-4333-8333-333333333333',
} as SearchTripsDto;

const RESULT = {
  dateStrip: [],
  trips: [],
  bookingWindow: {
    firstBookableDate: '2026-06-15',
    lastBookableDate: '2026-07-14',
    totalDays: 30,
  },
  evaluatedAt: {
    localDate: '2026-06-15',
    localTime: '12:00',
    utcOffset: '+03:00',
    iso: '2026-06-15T12:00:00+03:00',
    timeZone: 'Africa/Cairo',
  },
};

function controllerWith(searchOneWay: ReturnType<typeof vi.fn>) {
  return new CatalogController({ searchOneWay } as unknown as CatalogService);
}

function controllerFor(service: Partial<CatalogService>) {
  return new CatalogController(service as CatalogService);
}

/** A handler's descriptor, where Nest and the access decorators write. */
const handler = (name: keyof CatalogController): object =>
  Object.getOwnPropertyDescriptor(CatalogController.prototype, name)
    ?.value as object;

/**
 * The handler function, read through its descriptor, which is where Nest and
 * the access decorators write their metadata. Taken this way rather than as
 * `CatalogController.prototype.searchOneWay` so it is clear nothing here
 * intends to call an unbound method -- the same approach
 * `test/unit/route-access-levels.spec.ts` takes when it walks every route.
 */
const searchOneWayHandler = Object.getOwnPropertyDescriptor(
  CatalogController.prototype,
  'searchOneWay',
)?.value as object;

describe('the search route', () => {
  /**
   * Deny-by-default means a route with no access level is a 401 for everyone,
   * and `route-access-levels.spec.ts` fails the build for one. Asserting the
   * metadata here says which level was chosen and why, where a reader of this
   * module will see it.
   */
  it('requires a verified traveller', () => {
    const level = Reflect.getMetadata(ACCESS_LEVEL_KEY, searchOneWayHandler);

    // Not 'bookable': that is the profile-complete tier needed to book, and
    // searching comes before it. Not public: this design has no guest mode.
    expect(level).toBe('traveller');
  });

  it('is rate limited per caller', () => {
    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, searchOneWayHandler);

    expect(limit).toEqual({
      bucket: 'trip-search',
      limit: 60,
      windowSeconds: 60,
    });
  });

  it('passes the query through and returns the result', async () => {
    const searchOneWay = vi.fn().mockResolvedValue(RESULT);

    const response = await controllerWith(searchOneWay).searchOneWay(query);

    expect(response).toBe(RESULT);
    expect(searchOneWay.mock.calls[0][0]).toBe(query);
  });

  describe('the response language', () => {
    it('comes from Accept-Language', async () => {
      const searchOneWay = vi.fn().mockResolvedValue(RESULT);

      await controllerWith(searchOneWay).searchOneWay(query, 'en-GB,en;q=0.9');

      expect(searchOneWay.mock.calls[0][1]).toBe('en');
    });

    // BR-56: Arabic is the platform fallback, so a client that sends no header
    // gets Arabic rather than English-by-accident.
    it('falls back to Arabic when the header is absent', async () => {
      const searchOneWay = vi.fn().mockResolvedValue(RESULT);

      await controllerWith(searchOneWay).searchOneWay(query);

      expect(searchOneWay.mock.calls[0][1]).toBe('ar');
    });

    it('falls back to Arabic for an unsupported language', async () => {
      const searchOneWay = vi.fn().mockResolvedValue(RESULT);

      await controllerWith(searchOneWay).searchOneWay(query, 'fr-FR');

      expect(searchOneWay.mock.calls[0][1]).toBe('ar');
    });
  });
});

describe('the return-search route', () => {
  const returnQuery = {
    outboundTripId: '44444444-4444-4444-8444-444444444444',
    outboundFrom: query.from,
    outboundTo: query.to,
    returnDate: '2026-06-25',
    travelClassId: query.travelClassId,
  } as SearchReturnTripsDto;

  const returnResult = {
    trips: [],
    filterOptions: { trainTypes: [], minFareMinor: 0, maxFareMinor: 0 },
    evaluatedAt: RESULT.evaluatedAt,
  };

  it('requires a verified traveller', () => {
    expect(
      Reflect.getMetadata(ACCESS_LEVEL_KEY, handler('searchReturn')),
    ).toBe('traveller');
  });

  // Its own bucket: a different query with a different cost, and sharing one
  // would let either leg starve the other.
  it('has a rate-limit bucket of its own', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler('searchReturn'))).toEqual(
      { bucket: 'trip-search-return', limit: 60, windowSeconds: 60 },
    );
  });

  it('passes the query and the resolved language through', async () => {
    const searchReturn = vi.fn().mockResolvedValue(returnResult);

    const response = await controllerFor({ searchReturn }).searchReturn(
      returnQuery,
      'en',
    );

    expect(response).toBe(returnResult);
    expect(searchReturn.mock.calls[0][0]).toBe(returnQuery);
    expect(searchReturn.mock.calls[0][1]).toBe('en');
  });
});

describe('the stops route', () => {
  const stopsQuery = { from: query.from, to: query.to } as TripStopsQueryDto;

  it('requires a verified traveller', () => {
    expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, handler('tripStops'))).toBe(
      'traveller',
    );
  });

  // A traveller opens and closes this repeatedly while comparing trips, and
  // it is a cheaper, longer-cached read than a search.
  it('allows more calls than a search does', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler('tripStops'))).toEqual({
      bucket: 'trip-stops',
      limit: 120,
      windowSeconds: 60,
    });
  });

  it('passes the trip id from the path and the pair from the query', async () => {
    const tripStops = vi.fn().mockResolvedValue({ stops: [] });
    const tripId = '44444444-4444-4444-8444-444444444444';

    await controllerFor({ tripStops }).tripStops({ tripId }, stopsQuery);

    expect(tripStops).toHaveBeenCalledWith(tripId, stopsQuery);
  });
});

describe('the recent-searches route', () => {
  it('requires a verified traveller', () => {
    expect(
      Reflect.getMetadata(ACCESS_LEVEL_KEY, handler('recentSearches')),
    ).toBe('traveller');
  });

  it('is rate limited per caller', () => {
    expect(
      Reflect.getMetadata(RATE_LIMIT_KEY, handler('recentSearches')),
    ).toEqual({ bucket: 'recent-searches', limit: 60, windowSeconds: 60 });
  });

  /**
   * No Accept-Language is read, and no account is passed. Catalog returns both
   * languages for a recent search and the traveller comes from the verified
   * token, so there is nothing for this route to resolve or forward.
   */
  it('passes only the query through', async () => {
    const recentSearches = vi.fn().mockResolvedValue({ recentSearches: [] });
    const recentQuery = {} as RecentSearchesQueryDto;

    await controllerFor({ recentSearches }).recentSearches(recentQuery);

    expect(recentSearches).toHaveBeenCalledWith(recentQuery);
  });
});

/**
 * Nest matches routes in declaration order, so a parameterised route declared
 * before a literal one swallows it: `GET /trips/search/return` would arrive at
 * `:tripId/stops` with a tripId of "search". Asserted on the metadata rather
 * than through HTTP, because that is where the order is decided.
 */
describe('route ordering', () => {
  it('declares every literal path before the parameterised one', () => {
    const paths = (
      ['searchOneWay', 'searchReturn', 'recentSearches', 'tripStops'] as const
    ).map((name) => Reflect.getMetadata('path', handler(name)) as string);

    expect(paths).toEqual([
      'search',
      'search/return',
      'recent-searches',
      ':tripId/stops',
    ]);
    expect(paths.indexOf(':tripId/stops')).toBe(paths.length - 1);
  });
});
