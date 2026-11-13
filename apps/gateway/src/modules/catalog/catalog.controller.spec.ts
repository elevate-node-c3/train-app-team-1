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

/** Read route metadata from the handler descriptor. */
const handler = (name: keyof CatalogController): object =>
  Object.getOwnPropertyDescriptor(CatalogController.prototype, name)
    ?.value as object;

/** Read metadata without calling an unbound handler. */
const searchOneWayHandler = Object.getOwnPropertyDescriptor(
  CatalogController.prototype,
  'searchOneWay',
)?.value as object;

describe('the search route', () => {
  /** Pin the access level; missing metadata denies every caller. */
  it('requires a verified traveller', () => {
    const level = Reflect.getMetadata(ACCESS_LEVEL_KEY, searchOneWayHandler);

    // No guest access; verified travellers need not be bookable.
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

    // Missing language headers fall back to Arabic.
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
    expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, handler('searchReturn'))).toBe(
      'traveller',
    );
  });

  // Separate buckets keep either search leg from starving the other.
  it('has a rate-limit bucket of its own', () => {
    expect(
      Reflect.getMetadata(RATE_LIMIT_KEY, handler('searchReturn')),
    ).toEqual({ bucket: 'trip-search-return', limit: 60, windowSeconds: 60 });
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

  // Stop reads are cheaper and more heavily cached than searches.
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

  /** Both languages are returned; account identity comes from the verified token. */
  it('passes only the query through', async () => {
    const recentSearches = vi.fn().mockResolvedValue({ recentSearches: [] });
    const recentQuery = {} as RecentSearchesQueryDto;

    await controllerFor({ recentSearches }).recentSearches(recentQuery);

    expect(recentSearches).toHaveBeenCalledWith(recentQuery);
  });
});

/** Check metadata order so literal routes stay before trip-ID routes. */
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
