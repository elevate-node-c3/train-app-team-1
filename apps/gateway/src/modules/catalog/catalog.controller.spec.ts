import { ACCESS_LEVEL_KEY, RATE_LIMIT_KEY } from '@app/common';
import { describe, expect, it, vi } from 'vitest';

import { CatalogController } from './catalog.controller.js';
import type { CatalogService } from './catalog.service.js';
import type { SearchTripsDto } from './dto/search-trips.dto.js';

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
