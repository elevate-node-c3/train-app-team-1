import { Injectable } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  ErrorCode,
  civilDateTimeOf,
  type GetTripStopsRequest,
  type TripStop,
  type TripStopsResponse,
} from '@app/contracts';

import { CatalogSearchError } from './catalog-search-error.js';
import {
  isCachedTripStop,
  jitteredTtlSeconds,
  tripStopsCacheKey,
  TRIP_STOPS_TTL_JITTER_FRACTION,
  TRIP_STOPS_TTL_SECONDS,
  type CachedTripStop,
} from './trip-stops-cache.js';
import { TripStopsRepository } from './trip-stops.repository.js';

/**
 * The stops between the pair the search result offered.
 *
 * Cache-aside with a bounded, jittered TTL. An empty repository answer is not
 * cached: it is a refusal, not a fact about the timetable, and caching it
 * would keep telling a traveller their valid pair does not exist after the
 * data was fixed.
 */
@Injectable()
export class TripStopsService {
  constructor(
    private readonly repository: TripStopsRepository,
    private readonly cache: CacheAsideService,
  ) {}

  async stops(request: GetTripStopsRequest): Promise<TripStopsResponse> {
    const key = tripStopsCacheKey(request);
    const cached = await this.cache.get<unknown[]>(key);

    if (
      Array.isArray(cached) &&
      cached.length > 0 &&
      cached.every(isCachedTripStop)
    ) {
      this.cache.getMetrics?.()?.recordHit('trip-stops');
      return { stops: this.toWire(cached) };
    }

    this.cache.getMetrics?.()?.recordMiss('trip-stops');

    const rows = await this.repository.findStops(request);
    if (rows.length === 0) {
      throw new CatalogSearchError(ErrorCode.RESOURCE_NOT_FOUND, [
        {
          field: 'tripId',
          rejectedValue: request.tripId,
          issue: 'is not a trip that stops at these stations in this order',
          action:
            'Pick a trip from the search results and open its stops again',
        },
      ]);
    }

    const cachedStops: CachedTripStop[] = rows.map((row) => ({
      stationId: row.stationId,
      stationNameEn: row.stationNameEn,
      stationNameAr: row.stationNameAr,
      arrivalMillis: row.arrivalAt?.getTime() ?? null,
      departureMillis: row.departureAt?.getTime() ?? null,
    }));

    await this.cache.set(
      key,
      cachedStops,
      jitteredTtlSeconds(
        TRIP_STOPS_TTL_SECONDS,
        TRIP_STOPS_TTL_JITTER_FRACTION,
      ),
    );

    return { stops: this.toWire(cachedStops) };
  }

  /**
   * Drops this segment's entry.
   */
  async invalidate(
    tripId: string,
    originStationId: string,
    destinationStationId: string,
  ): Promise<void> {
    await this.cache.del(
      tripStopsCacheKey({ tripId, originStationId, destinationStationId }),
    );
  }

  private toWire(stops: readonly CachedTripStop[]): TripStop[] {
    return stops.map((stop, index) => ({
      stationId: stop.stationId,
      name: { en: stop.stationNameEn, ar: stop.stationNameAr },
      // Optional on the wire because an endpoint has only one of the two.
      ...(stop.arrivalMillis === null
        ? {}
        : { arrival: civilDateTimeOf(new Date(stop.arrivalMillis)) }),
      ...(stop.departureMillis === null
        ? {}
        : { departure: civilDateTimeOf(new Date(stop.departureMillis)) }),
      boarding: index === 0,
      alighting: index === stops.length - 1,
    }));
  }
}
