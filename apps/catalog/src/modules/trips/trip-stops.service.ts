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
 * Use a bounded, jittered TTL. Never cache empty repository answers: they are
 * refusals and must not hide trips after data is repaired.
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
          issueKey: 'ISSUE_TRIP_DOES_NOT_SERVE_PAIR',
          actionKey: 'ACTION_PICK_TRIP_FROM_RESULTS',
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
