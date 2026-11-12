import type { SearchReturnTripsRequest } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CatalogSearchError } from './catalog-search-error.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripDayService } from './trip-day.service.js';
import { TripReturnSearchService } from './trip-return-search.service.js';
import type { TripSearchRow } from './trip-search.types.js';

/**
 * The return leg, with its two load-bearing rules under test: the lower bound
 * is the outbound trip's arrival as the SERVER read it, and the reverse search
 * is a plain day query that must land on the shared cache key.
 */

const RAMSIS = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';
const FIRST = '33333333-3333-4333-8333-333333333333';
const EXPRESS_TYPE = '44444444-4444-4444-8444-444444444444';
const OUTBOUND_TRIP = '55555555-5555-4555-8555-555555555555';

/** 12:00 Cairo on 15 June. The window is 2026-06-15 .. 2026-07-14. */
const NOW = new Date('2026-06-15T09:00:00Z');

/** Ramsis 06:00 -> Alexandria 08:40 Cairo, on 20 June. */
const OUTBOUND_SEGMENT = {
  originStationId: RAMSIS,
  destinationStationId: ALEX,
  originDepartureAt: new Date('2026-06-20T03:00:00Z'),
  destinationArrivalAt: new Date('2026-06-20T05:40:00Z'),
  cairoDepartureDate: '2026-06-20',
};

const request = (
  overrides: Partial<SearchReturnTripsRequest> = {},
): SearchReturnTripsRequest => ({
  outboundTripId: OUTBOUND_TRIP,
  outboundOriginStationId: RAMSIS,
  outboundDestinationStationId: ALEX,
  returnDate: '2026-06-25',
  travelClassId: FIRST,
  ...overrides,
});

/** A return candidate leaving Alexandria at a Cairo wall-clock time. */
function returnRow(
  departureIso: string,
  overrides: Partial<TripSearchRow> = {},
): TripSearchRow {
  const departure = new Date(departureIso);

  return {
    tripId: `return-${departureIso}`,
    trainNumber: 904,
    trainTypeId: EXPRESS_TYPE,
    trainTypeEn: 'Express',
    trainTypeAr: 'مميز',
    originStationId: ALEX,
    originNameEn: 'Misr Station',
    originNameAr: 'محطة مصر',
    originDepartureAt: departure,
    destinationStationId: RAMSIS,
    destinationNameEn: 'Ramsis',
    destinationNameAr: 'رمسيس',
    destinationArrivalAt: new Date(departure.getTime() + 160 * 60 * 1000),
    travelClassNameEn: 'First Class',
    travelClassNameAr: 'الدرجة الأولى',
    intermediateStops: 2,
    classCapacity: 40,
    farePiastres: 15_500,
    ...overrides,
  };
}

function makeService(
  options: {
    rows?: TripSearchRow[];
    segment?: typeof OUTBOUND_SEGMENT | null;
    probe?: { routeServed: boolean; trainServesRoute: boolean };
    activeStationIds?: Set<string>;
  } = {},
) {
  const repository = {
    findCandidates: vi.fn().mockResolvedValue(options.rows ?? []),
    findPassengerSegment: vi
      .fn()
      .mockResolvedValue(
        options.segment === undefined ? OUTBOUND_SEGMENT : options.segment,
      ),
    probeRouteServed: vi
      .fn()
      .mockResolvedValue(
        options.probe ?? { routeServed: true, trainServesRoute: false },
      ),
  };

  const references = {
    resolveReferences: vi.fn().mockResolvedValue({
      knownStationIds: new Set([RAMSIS, ALEX]),
      activeStationIds: options.activeStationIds ?? new Set([RAMSIS, ALEX]),
      travelClassExists: true,
      trainExists: false,
      trainId: null,
    }),
  };

  const cache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  };

  const service = new TripReturnSearchService(
    repository as never,
    references as never,
    new SeatAvailabilityService(),
    new TripDayService(repository as never, cache as never),
  );

  return { service, repository, references, cache };
}

describe('the return search service', () => {
  describe('the reverse route', () => {
    it('searches from the outbound destination back to its origin', async () => {
      const { service, repository } = makeService({
        rows: [returnRow('2026-06-25T06:00:00Z')],
      });

      await service.search(request(), NOW);

      expect(repository.findCandidates).toHaveBeenCalledWith(
        expect.objectContaining({
          originStationId: ALEX,
          destinationStationId: RAMSIS,
          serviceDate: '2026-06-25',
          travelClassId: FIRST,
          // A train number narrowed the outbound leg only; a return train has
          // its own.
          trainNumber: null,
        }),
      );
    });

    // The round trip must not fragment the cache: the return list is the same
    // day of the same route any one-way search for it would read.
    it('reads the day through the shared cache key', async () => {
      const { service, cache } = makeService({
        rows: [returnRow('2026-06-25T06:00:00Z')],
      });

      await service.search(request(), NOW);

      const key = cache.get.mock.calls[0][0] as string;
      expect(key).toBe(
        `catalog:search:v2:${ALEX}:${RAMSIS}:2026-06-25:${FIRST}:*`,
      );
    });

    it('takes the stations from the trip, not from the request', async () => {
      // A client naming stations the chosen trip does not serve cannot steer
      // the return search: the segment the server read decides.
      const { service, repository } = makeService({
        rows: [returnRow('2026-06-25T06:00:00Z')],
      });

      await service.search(request({ outboundOriginStationId: FIRST }), NOW);

      expect(repository.findCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ destinationStationId: RAMSIS }),
      );
    });
  });

  describe('the after-arrival bound (BR-20)', () => {
    it('keeps only trips departing after the outbound arrives', async () => {
      const { service } = makeService({
        rows: [
          // The outbound lands at 08:40 Cairo on the 20th; these are the 25th.
          returnRow('2026-06-25T02:00:00Z'),
          returnRow('2026-06-25T06:00:00Z'),
        ],
      });

      const response = await service.search(request(), NOW);

      // Both are after 2026-06-20T05:40Z, so both survive.
      expect(response.trips).toHaveLength(2);
    });

    // The story's edge case: an outbound arriving at 23:50 leaves no same-day
    // return, and the traveller is told that rather than shown a wrong list.
    it('drops a trip that departs before the arrival', async () => {
      const { service } = makeService({
        segment: {
          ...OUTBOUND_SEGMENT,
          // Arrives 23:50 Cairo on the 25th: a same-day return is impossible.
          destinationArrivalAt: new Date('2026-06-25T20:50:00Z'),
          cairoDepartureDate: '2026-06-25',
        },
        rows: [returnRow('2026-06-25T18:00:00Z')],
      });

      const response = await service.search(request(), NOW);

      expect(response.trips).toEqual([]);
      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
      );
    });

    // Strictly after, with no minimum connection time: the platform does not
    // know how long this station takes to cross, so it invents nothing.
    it('excludes a trip departing at the exact arrival instant', async () => {
      const { service } = makeService({
        rows: [returnRow(OUTBOUND_SEGMENT.destinationArrivalAt.toISOString())],
      });

      const response = await service.search(request(), NOW);

      expect(response.trips).toEqual([]);
    });

    it('names the outbound arrival in the empty result, so the edge can quote it', async () => {
      const { service } = makeService({
        rows: [returnRow('2026-06-20T02:00:00Z')],
        segment: OUTBOUND_SEGMENT,
      });

      const response = await service.search(
        request({ returnDate: '2026-06-20' }),
        NOW,
      );

      expect(response.emptyResult?.params).toMatchObject({
        outboundArrivalDate: '2026-06-20',
        outboundArrivalTime: '08:40',
        outboundTripId: OUTBOUND_TRIP,
      });
    });
  });

  describe('the empty result says what to change', () => {
    it('blames the date when nothing runs that day', async () => {
      const { service, repository } = makeService({ rows: [] });

      const response = await service.search(request(), NOW);

      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_NO_TRIPS_ON_DATE',
      );
      expect(repository.probeRouteServed).toHaveBeenCalledTimes(1);
    });

    it('blames the stations when the reverse direction is not served', async () => {
      const { service } = makeService({
        rows: [],
        probe: { routeServed: false, trainServesRoute: false },
      });

      const response = await service.search(request(), NOW);

      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_ROUTE_NOT_SERVED',
      );
    });

    it('blames the filters only when the arrival bound left something', async () => {
      const { service, repository } = makeService({
        rows: [returnRow('2026-06-25T06:00:00Z')],
      });

      const response = await service.search(
        request({ filters: { maxFareMinor: 1 } }),
        NOW,
      );

      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_FILTERS_EXCLUDED_ALL',
      );
      // The day had trips, so the route is served by construction.
      expect(repository.probeRouteServed).not.toHaveBeenCalled();
    });

    // The arrival bound outranks the filters: a filter the traveller changes
    // would not bring back a train that left before they landed.
    it('blames the arrival rather than the filters when both would apply', async () => {
      const { service } = makeService({
        rows: [returnRow('2026-06-20T02:00:00Z')],
      });

      const response = await service.search(
        request({ returnDate: '2026-06-20', filters: { maxFareMinor: 1 } }),
        NOW,
      );

      expect(response.emptyResult?.reason).toBe(
        'SEARCH_EMPTY_REASON_NOTHING_AFTER_OUTBOUND_ARRIVAL',
      );
    });
  });

  describe('refusals', () => {
    it('refuses a withdrawn or unknown outbound trip', async () => {
      const { service, repository } = makeService({ segment: null });

      const error = (await service
        .search(request(), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error).toBeInstanceOf(CatalogSearchError);
      expect(error.details[0].field).toBe('outboundTripId');
      expect(repository.findCandidates).not.toHaveBeenCalled();
    });

    it('refuses a malformed outbound trip id without reading anything', async () => {
      const { service, repository } = makeService();

      const error = (await service
        .search(request({ outboundTripId: 'not-a-uuid' }), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error.details.map((detail) => detail.field)).toEqual([
        'outboundTripId',
      ]);
      expect(error.details[0]).toMatchObject({
        issueKey: 'ISSUE_OUTBOUND_TRIP_ID_MALFORMED',
        actionKey: 'ACTION_SEARCH_AGAIN_FOR_OUTBOUND',
      });
      expect(repository.findPassengerSegment).not.toHaveBeenCalled();
    });

    // The return date is judged against the chosen trip's own departure date,
    // which the server read -- never against a date the client sent.
    it('refuses a return date before the outbound trip departs', async () => {
      const { service, repository } = makeService();

      const error = (await service
        .search(request({ returnDate: '2026-06-19' }), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error.details[0].field).toBe('returnDate');
      expect(error.details[0]).toMatchObject({
        issueKey: 'ISSUE_RETURN_BEFORE_DEPARTURE',
        actionKey: 'ACTION_PICK_RETURN_DATE_ON_OR_AFTER',
        params: { departureDate: '2026-06-20' },
      });
      expect(repository.findCandidates).not.toHaveBeenCalled();
    });

    it('accepts a return date on the departure date itself', async () => {
      const { service } = makeService({
        rows: [returnRow('2026-06-20T18:00:00Z')],
      });

      const response = await service.search(
        request({ returnDate: '2026-06-20' }),
        NOW,
      );

      expect(response.trips).toHaveLength(1);
    });

    it('refuses a return date past the booking window', async () => {
      const { service } = makeService();

      const error = (await service
        .search(request({ returnDate: '2026-08-01' }), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error.details[0].field).toBe('returnDate');
      expect(error.details[0]).toMatchObject({
        issueKey: 'ISSUE_DATE_BEYOND_BOOKING_WINDOW',
        actionKey: 'ACTION_PICK_DATE_IN_BOOKING_WINDOW',
        params: {
          firstBookableDate: '2026-06-15',
          lastBookableDate: '2026-07-14',
        },
      });
    });

    it('refuses a malformed filter', async () => {
      const { service, repository } = makeService();

      const error = (await service
        .search(request({ filters: { maxFareMinor: -1 } }), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error.details.map((detail) => detail.field)).toEqual([
        'maxFareMinor',
      ]);
      expect(repository.findPassengerSegment).not.toHaveBeenCalled();
    });

    // Refused, not answered empty: "nothing runs that day" would send the
    // traveller to change the date forever for a station that never answers.
    it('refuses a deactivated station on the reverse route', async () => {
      const { service } = makeService({
        activeStationIds: new Set([RAMSIS]),
      });

      const error = (await service
        .search(request(), NOW)
        .catch((caught: unknown) => caught)) as CatalogSearchError;

      expect(error.details[0].field).toBe('outboundDestinationStationId');
    });
  });

  describe('the list itself', () => {
    it('sorts and narrows exactly as the outbound leg does', async () => {
      const { service } = makeService({
        rows: [
          returnRow('2026-06-25T10:00:00Z', {
            tripId: 'dear',
            farePiastres: 20_000,
          }),
          returnRow('2026-06-25T06:00:00Z', {
            tripId: 'cheap',
            farePiastres: 9_000,
          }),
        ],
      });

      const byFare = await service.search(
        request({ sort: 'SEARCH_SORT_FARE_ASC' }),
        NOW,
      );

      expect(byFare.trips.map((trip) => trip.tripId)).toEqual([
        'cheap',
        'dear',
      ]);
    });

    it('reports the facets of what survived the arrival bound', async () => {
      const { service } = makeService({
        rows: [
          returnRow('2026-06-25T06:00:00Z', { farePiastres: 9_000 }),
          returnRow('2026-06-25T10:00:00Z', { farePiastres: 20_000 }),
        ],
      });

      const response = await service.search(request(), NOW);

      expect(response.filterOptions?.minFareMinor).toBe(9_000);
      expect(response.filterOptions?.maxFareMinor).toBe(20_000);
      expect(response.filterOptions?.trainTypes).toHaveLength(1);
    });

    // No date strip and no booking window: the outbound call already sent
    // both, and repeating them would let the two disagree.
    it('carries no date strip or booking window', async () => {
      const { service } = makeService({
        rows: [returnRow('2026-06-25T06:00:00Z')],
      });

      const response = await service.search(request(), NOW);

      expect(response).not.toHaveProperty('dateStrip');
      expect(response).not.toHaveProperty('bookingWindow');
      expect(response.evaluatedAt.localDate).toBe('2026-06-15');
    });
  });
});
