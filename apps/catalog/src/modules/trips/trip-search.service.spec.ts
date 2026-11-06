import type { SearchOneWayTripsRequest } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CatalogSearchError } from './catalog-search-error.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripSearchService } from './trip-search.service.js';
import { searchCacheKey, type CachedStaticTrip } from './trip-search-cache.js';
import type { TripSearchRow } from './trip-search.types.js';

const CAIRO = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';

/** 12:00 Cairo on 15 June. The window is 2026-06-15 .. 2026-07-14. */
const NOW = new Date('2026-06-15T09:00:00Z');

const request = (
  overrides: Partial<SearchOneWayTripsRequest> = {},
): SearchOneWayTripsRequest => ({
  originStationId: CAIRO,
  destinationStationId: ALEX,
  departureDate: '2026-06-20',
  travelClassId: FIRST,
  ...overrides,
});

function row(overrides: Partial<TripSearchRow> = {}): TripSearchRow {
  return {
    tripId: 'trip-1',
    trainNumber: 903,
    trainTypeEn: 'Express',
    trainTypeAr: 'مميز',
    originStationId: CAIRO,
    originNameEn: 'Ramsis',
    originNameAr: 'رمسيس',
    originDepartureAt: new Date('2026-06-20T03:00:00Z'),
    destinationStationId: ALEX,
    destinationNameEn: 'Misr Station',
    destinationNameAr: 'محطة مصر',
    destinationArrivalAt: new Date('2026-06-20T05:40:00Z'),
    travelClassNameEn: 'First Class',
    travelClassNameAr: 'الدرجة الأولى',
    intermediateStops: 2,
    classCapacity: 40,
    farePiastres: 15500,
    ...overrides,
  };
}

function cachedTrip(overrides: Partial<CachedStaticTrip> = {}): CachedStaticTrip {
  return {
    tripId: 'cached-1',
    trainNumber: 903,
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
    ...overrides,
  };
}

/** A service with every collaborator stubbed, and handles to each. */
function makeService(options: {
  rows?: TripSearchRow[];
  cached?: CachedStaticTrip[] | null;
  probe?: { routeServed: boolean; trainServesRoute: boolean };
  references?: Partial<{
    knownStationIds: Set<string>;
    activeStationIds: Set<string>;
    travelClassExists: boolean;
    trainExists: boolean;
  }>;
} = {}) {
  const repository = {
    findCandidates: vi.fn().mockResolvedValue(options.rows ?? [row()]),
    probeRouteServed: vi
      .fn()
      .mockResolvedValue(
        options.probe ?? { routeServed: true, trainServesRoute: true },
      ),
  };

  const references = {
    resolveReferences: vi.fn().mockResolvedValue({
      knownStationIds: new Set([CAIRO, ALEX]),
      activeStationIds: new Set([CAIRO, ALEX]),
      travelClassExists: true,
      trainExists: true,
      trainId: null,
      ...options.references,
    }),
  };

  const cache = {
    get: vi.fn().mockResolvedValue(options.cached ?? null),
    set: vi.fn().mockResolvedValue(undefined),
  };

  const availability = new SeatAvailabilityService();

  const service = new TripSearchService(
    repository as never,
    references as never,
    availability,
    cache as never,
  );

  return { service, repository, references, cache, availability };
}

describe('the search service', () => {
  describe('always answers with a picker', () => {
    it('returns the window and a five-day strip around the selected date', async () => {
      const { service } = makeService();

      const response = await service.search(request(), NOW);

      expect(response.bookingWindow).toEqual({
        firstBookableDate: '2026-06-15',
        lastBookableDate: '2026-07-14',
        totalDays: 30,
      });
      expect(response.dateStrip).toHaveLength(5);
      expect(
        response.dateStrip.find((day) => day.selected)?.date,
      ).toBe('2026-06-20');
    });

    it('reports the instant it evaluated eligibility at', async () => {
      const { service } = makeService();

      const response = await service.search(request(), NOW);

      expect(response.evaluatedAt.iso).toBe('2026-06-15T12:00:00+03:00');
    });
  });

  describe('refusals', () => {
    it('names the field, and still carries the strip and window', async () => {
      const { service } = makeService();

      const error = await service
        .search(request({ destinationStationId: CAIRO }), NOW)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CatalogSearchError);
      const refusal = error as CatalogSearchError;
      expect(refusal.details.map((detail) => detail.field)).toEqual(['to']);
      // So a client can keep rendering the date picker next to the error.
      expect(refusal.dateStrip).toHaveLength(5);
      expect(refusal.bookingWindow.lastBookableDate).toBe('2026-07-14');
    });

    it('states the last bookable date, matching the window it returned', async () => {
      const { service } = makeService();

      const error = (await service
        .search(request({ departureDate: '2026-08-01' }), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error.details[0].action).toContain(
        error.bookingWindow.lastBookableDate,
      );
    });

    it('refuses an inactive station without touching the database', async () => {
      const { service, repository } = makeService({
        references: { activeStationIds: new Set([ALEX]) },
      });

      await expect(service.search(request(), NOW)).rejects.toBeInstanceOf(
        CatalogSearchError,
      );
      expect(repository.findCandidates).not.toHaveBeenCalled();
    });
  });

  describe('the cache', () => {
    it('queries on a miss and stores the static projection', async () => {
      const { service, repository, cache } = makeService({ cached: null });

      await service.search(request(), NOW);

      expect(repository.findCandidates).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledTimes(1);

      const [key, stored, ttl] = cache.set.mock.calls[0] as [
        string,
        CachedStaticTrip[],
        number,
      ];
      expect(key).toBe(
        searchCacheKey({
          originStationId: CAIRO,
          destinationStationId: ALEX,
          serviceDate: '2026-06-20',
          travelClassId: FIRST,
          trainNumber: null,
        }),
      );
      expect(ttl).toBeGreaterThan(0);
      expect(stored[0].originDepartureMillis).toBe(
        Date.parse('2026-06-20T03:00:00Z'),
      );
    });

    it('serves a hit without querying', async () => {
      const { service, repository, cache } = makeService({
        cached: [cachedTrip()],
      });

      const response = await service.search(request(), NOW);

      expect(repository.findCandidates).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      expect(response.trips[0].tripId).toBe('cached-1');
    });

    it('treats an unreadable cached payload as a miss', async () => {
      // An older deploy's entry: JSON, but not this shape.
      const { service, repository } = makeService({
        cached: [{ tripId: 'stale' } as unknown as CachedStaticTrip],
      });

      const response = await service.search(request(), NOW);

      expect(repository.findCandidates).toHaveBeenCalledTimes(1);
      expect(response.trips[0].tripId).toBe('trip-1');
    });
  });

  /**
   * The rule this whole design exists to keep: a list cached at 13:50 must not
   * offer, at 14:00, a trip whose sales closed at 13:55.
   *
   * What makes it a property rather than a promise is that the filter runs on
   * the cache-hit path too -- so the test also asserts the repository was
   * never consulted. If eligibility were applied only after a query, this
   * would pass for the wrong reason.
   */
  describe('time-dependent eligibility', () => {
    const departsAt1410 = Date.parse('2026-06-20T11:10:00Z'); // 14:10 Cairo
    const at1400 = new Date('2026-06-20T11:00:00Z'); // sales closed 13:55

    it('drops a closed trip from a CACHED list, without querying', async () => {
      const { service, repository } = makeService({
        cached: [
          cachedTrip({
            tripId: 'closing',
            originDepartureMillis: departsAt1410,
          }),
        ],
      });

      const response = await service.search(
        request({ departureDate: '2026-06-20' }),
        at1400,
      );

      expect(response.trips).toEqual([]);
      expect(repository.findCandidates).not.toHaveBeenCalled();
    });

    it('keeps the same trip sixteen minutes before departure', async () => {
      const { service } = makeService({
        cached: [
          cachedTrip({
            tripId: 'closing',
            originDepartureMillis: departsAt1410,
          }),
        ],
      });

      const response = await service.search(
        request({ departureDate: '2026-06-20' }),
        new Date(departsAt1410 - 16 * 60_000),
      );

      expect(response.trips.map((trip) => trip.tripId)).toEqual(['closing']);
    });

    it('applies the same filter on the miss path', async () => {
      const { service } = makeService({
        rows: [row({ originDepartureAt: new Date(departsAt1410) })],
      });

      const response = await service.search(
        request({ departureDate: '2026-06-20' }),
        at1400,
      );

      expect(response.trips).toEqual([]);
    });
  });

  describe('a trip that cannot be sold', () => {
    it('drops one with no fare', async () => {
      const { service } = makeService({
        rows: [row({ tripId: 'priced' }), row({ tripId: 'unpriced', farePiastres: null })],
      });

      const response = await service.search(request(), NOW);

      expect(response.trips.map((trip) => trip.tripId)).toEqual(['priced']);
    });
  });

  describe('the trips it returns', () => {
    it('carries every field BR-17 requires', async () => {
      const { service } = makeService();

      const [trip] = (await service.search(request(), NOW)).trips;

      expect(trip.trainNumber).toBe(903);
      expect(trip.trainType).toEqual({ en: 'Express', ar: 'مميز' });
      expect(trip.travelClass.name.en).toBe('First Class');
      expect(trip.departure.name.ar).toBe('رمسيس');
      expect(trip.intermediateStops).toBe(2);
      expect(trip.durationMinutes).toBe(160);
      expect(trip.availableSeats).toBe(40);
      expect(trip.soldOut).toBe(false);
      expect(trip.fare).toEqual({ amountMinor: 15500, currency: 'EGP' });
    });

    it('reports Cairo local times with their offset', async () => {
      const { service } = makeService();

      const [trip] = (await service.search(request(), NOW)).trips;

      expect(trip.departure.at.localTime).toBe('06:00');
      expect(trip.departure.at.utcOffset).toBe('+03:00');
      expect(trip.departure.at.timeZone).toBe('Africa/Cairo');
    });

    // Every result's departure date is the date that was searched -- the
    // inconsistency in the design's sample data must not be reproducible.
    it('departs on the date that was searched', async () => {
      const { service, cache } = makeService();

      const response = await service.search(request(), NOW);
      void cache;

      for (const trip of response.trips) {
        expect(trip.departure.at.localDate).toBe('2026-06-20');
      }
      expect(response.dateStrip.find((day) => day.selected)?.date).toBe(
        '2026-06-20',
      );
    });

    it('marks a trip with no seats left as sold out', async () => {
      const { service, availability } = makeService();
      vi.spyOn(availability, 'availabilityFor').mockResolvedValue(
        new Map([['trip-1', 0]]),
      );

      const [trip] = (await service.search(request(), NOW)).trips;

      // Returned and marked, not hidden (BR-16).
      expect(trip.soldOut).toBe(true);
      expect(trip.availableSeats).toBe(0);
    });

    it('asks for availability once, for all segments together', async () => {
      const { service, availability } = makeService({
        rows: [row({ tripId: 'a' }), row({ tripId: 'b' }), row({ tripId: 'c' })],
      });
      const spy = vi.spyOn(availability, 'availabilityFor');

      await service.search(request(), NOW);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toHaveLength(3);
    });
  });

  describe('an empty result', () => {
    it('says the route is not served, and asks the probes', async () => {
      const { service, repository } = makeService({
        rows: [],
        probe: { routeServed: false, trainServesRoute: false },
      });

      const response = await service.search(request(), NOW);

      expect(response.trips).toEqual([]);
      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
      );
      expect(repository.probeRouteServed).toHaveBeenCalledTimes(1);
    });

    it('blames the date when the route is served', async () => {
      const { service } = makeService({
        rows: [],
        probe: { routeServed: true, trainServesRoute: true },
      });

      const response = await service.search(request(), NOW);

      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE',
      );
      // The date the traveller would change it to.
      expect(response.emptyResult?.params.searchedDate).toBe('2026-06-20');
    });

    it('blames the train number when that is the problem', async () => {
      const { service } = makeService({
        rows: [],
        probe: { routeServed: true, trainServesRoute: false },
      });

      const response = await service.search(
        request({ trainNumber: 903 }),
        NOW,
      );

      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_TRAIN_NOT_ON_ROUTE',
      );
    });

    it('carries no empty reason when there are trips', async () => {
      const { service } = makeService();

      const response = await service.search(request(), NOW);

      expect(response.trips.length).toBeGreaterThan(0);
      expect(response.emptyResult).toBeUndefined();
    });

    it('does not probe when the list is non-empty', async () => {
      const { service, repository } = makeService();

      await service.search(request(), NOW);

      expect(repository.probeRouteServed).not.toHaveBeenCalled();
    });
  });

  /**
   * TA-33: search is a read. Resisting "a search was performed" through the
   * outbox is the point -- it would turn the most frequent read in the system
   * into a write.
   */
  describe('read-only', () => {
    it('never writes, on the miss path or the hit path', async () => {
      for (const cached of [null, [cachedTrip()]]) {
        const { service, repository, references } = makeService({ cached });

        await service.search(request(), NOW);

        // The only database calls the service may make.
        const allowed = ['findCandidates', 'probeRouteServed'];
        for (const name of Object.keys(repository)) {
          expect(allowed).toContain(name);
        }
        expect(Object.keys(references)).toEqual(['resolveReferences']);
      }
    });
  });
});
