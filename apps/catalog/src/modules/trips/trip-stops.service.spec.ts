import { ErrorCode, type GetTripStopsRequest } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CatalogSearchError } from './catalog-search-error.js';
import type { CachedTripStop } from './trip-stops-cache.js';
import { tripStopsCacheKey } from './trip-stops-cache.js';
import { TripStopsService } from './trip-stops.service.js';
import type { TripStopRow } from './trip-search.types.js';

const TRIP = '11111111-1111-4111-8111-111111111111';
const CAIRO = '22222222-2222-4222-8222-222222222222';
const ALEX = '33333333-3333-4333-8333-333333333333';

const request: GetTripStopsRequest = {
  tripId: TRIP,
  originStationId: CAIRO,
  destinationStationId: ALEX,
};

const row = (overrides: Partial<TripStopRow> = {}): TripStopRow => ({
  stationId: CAIRO,
  stationNameEn: 'Ramsis',
  stationNameAr: 'رمسيس',
  arrivalAt: null,
  departureAt: new Date('2026-06-20T03:00:00Z'),
  ...overrides,
});

const cachedStop = (
  overrides: Partial<CachedTripStop> = {},
): CachedTripStop => ({
  stationId: CAIRO,
  stationNameEn: 'Ramsis',
  stationNameAr: 'رمسيس',
  arrivalMillis: null,
  departureMillis: Date.parse('2026-06-20T03:00:00Z'),
  ...overrides,
});

function makeService(options: { rows?: TripStopRow[]; cached?: unknown } = {}) {
  const repository = {
    findStops: vi.fn().mockResolvedValue(
      options.rows ?? [
        row(),
        row({
          stationId: ALEX,
          stationNameEn: 'Misr Station',
          stationNameAr: 'محطة مصر',
          arrivalAt: new Date('2026-06-20T05:40:00Z'),
          departureAt: null,
        }),
      ],
    ),
  };

  const cache = {
    get: vi.fn().mockResolvedValue(options.cached ?? null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };

  const service = new TripStopsService(repository as never, cache as never);

  return { service, repository, cache };
}

describe('the trip-stops service', () => {
  it('answers with every stop in travel order and Cairo times', async () => {
    const { service, repository, cache } = makeService();

    const response = await service.stops(request);

    expect(repository.findStops).toHaveBeenCalledWith(request);
    expect(response.stops).toHaveLength(2);

    const [boarding, alighting] = response.stops;
    expect(boarding.stationId).toBe(CAIRO);
    expect(boarding.name).toEqual({ en: 'Ramsis', ar: 'رمسيس' });
    expect(boarding.boarding).toBe(true);
    expect(boarding.alighting).toBe(false);
    expect(boarding.arrival).toBeUndefined();
    expect(boarding.departure?.localTime).toBe('06:00');
    expect(boarding.departure?.utcOffset).toBe('+03:00');

    expect(alighting.stationId).toBe(ALEX);
    expect(alighting.boarding).toBe(false);
    expect(alighting.alighting).toBe(true);
    expect(alighting.arrival?.localTime).toBe('08:40');
    expect(alighting.departure).toBeUndefined();

    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it('caches the static stops under the segment key, never the wire shape', async () => {
    const { service, cache } = makeService();

    await service.stops(request);

    const [key, stored, ttl] = cache.set.mock.calls[0] as [
      string,
      CachedTripStop[],
      number,
    ];
    expect(key).toBe(tripStopsCacheKey(request));
    expect(stored[0].departureMillis).toBe(Date.parse('2026-06-20T03:00:00Z'));
    expect(stored[1].arrivalMillis).toBe(Date.parse('2026-06-20T05:40:00Z'));
    // Inside the six-hour, ten-percent band.
    expect(ttl).toBeGreaterThanOrEqual(6 * 60 * 60 * 0.9);
    expect(ttl).toBeLessThanOrEqual(6 * 60 * 60 * 1.1);
  });

  it('serves a cache hit without touching the repository', async () => {
    const { service, repository } = makeService({
      cached: [
        cachedStop(),
        cachedStop({
          stationId: ALEX,
          stationNameEn: 'Misr Station',
          stationNameAr: 'محطة مصر',
          arrivalMillis: Date.parse('2026-06-20T05:40:00Z'),
          departureMillis: null,
        }),
      ],
    });

    const response = await service.stops(request);

    expect(repository.findStops).not.toHaveBeenCalled();
    expect(response.stops).toHaveLength(2);
    expect(response.stops[0].boarding).toBe(true);
    expect(response.stops[1].alighting).toBe(true);
  });

  it('treats an unreadable cached payload as a miss', async () => {
    const { service, repository } = makeService({
      cached: [{ stationId: CAIRO }],
    });

    const response = await service.stops(request);

    expect(repository.findStops).toHaveBeenCalledTimes(1);
    expect(response.stops).toHaveLength(2);
  });

  it('refuses a pair that is not on the trip, and does not cache the refusal', async () => {
    const { service, cache } = makeService({ rows: [] });

    const error = await service
      .stops(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CatalogSearchError);
    const refusal = error as CatalogSearchError;
    expect(refusal.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
    expect(refusal.details[0]).toMatchObject({
      field: 'tripId',
      rejectedValue: TRIP,
    });
    expect(refusal.details[0].action).not.toBe('');
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('invalidates exactly this segment', async () => {
    const { service, cache } = makeService();

    await service.invalidate(TRIP, CAIRO, ALEX);

    expect(cache.del).toHaveBeenCalledWith(tripStopsCacheKey(request));
  });
});
