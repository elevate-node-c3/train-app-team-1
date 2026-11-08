import { Injectable, Optional } from '@nestjs/common';
import { CacheAsideService, RedisClientService } from '@app/common';
import { durationMinutesBetween } from '@app/contracts';

import {
  jitteredTtlSeconds,
  SEARCH_CACHE_TTL_EMPTY_SECONDS,
  SEARCH_CACHE_TTL_JITTER_FRACTION,
} from '../cache/catalog-cache.keys.js';
import { RouteVersionService } from '../cache/route-version.service.js';
import { TripSearchRepository } from './trip-search.repository.js';
import {
  cacheTtlSecondsFor,
  isCachedStaticTrip,
  searchCacheKey,
  type CachedStaticTrip,
} from './trip-search-cache.js';
import type { TripSearchRow } from './trip-search.types.js';

/** One day of one route in one class, as both legs ask for it. */
export interface TripDayQuery {
  originStationId: string;
  destinationStationId: string;
  /** The Cairo civil date being searched, 'YYYY-MM-DD'. */
  serviceDate: string;
  travelClassId: string;
  /** Null means "any train". */
  trainNumber: number | null;
}

/**
 * A day's static trips, from the cache when they are there and from Postgres
 * when they are not.
 */
@Injectable()
export class TripDayService {
  private readonly routeVersion: RouteVersionService;

  constructor(
    private readonly trips: TripSearchRepository,
    private readonly cache: CacheAsideService,
    @Optional() routeVersion?: RouteVersionService,
  ) {
    this.routeVersion =
      routeVersion ?? new RouteVersionService(new RedisClientService());
  }

  /**
   * A cached entry that does not match the current shape is treated as a miss:
   * it parses as JSON and would otherwise put `undefined` into a traveller's
   * results.
   */
  async staticTripsFor(
    query: TripDayQuery,
    now: Date,
  ): Promise<CachedStaticTrip[]> {
    // 1. Capture route version before database read (§6.3, interleaving protection)
    const capturedVersion = await this.routeVersion.getRouteVersion(
      query.originStationId,
      query.destinationStationId,
    );

    const key = searchCacheKey({ ...query, routeVersion: capturedVersion });
    const baseTtl = cacheTtlSecondsFor(query.serviceDate, now);
    const ttl = jitteredTtlSeconds(baseTtl, SEARCH_CACHE_TTL_JITTER_FRACTION);

    // 2. Coalesce concurrent requests on a cold key through stampede guard (§2.3 rule 3)
    const result = await this.cache.getOrRebuild<CachedStaticTrip[]>(
      key,
      'search',
      async () => {
        const rows = await this.trips.findCandidates({ ...query, now });
        return rows.map((row) => toStatic(row));
      },
      ttl,
    );

    if (Array.isArray(result) && result.every(isCachedStaticTrip)) {
      return result;
    }

    // Corrupted payload recovery fallback
    const freshRows = await this.trips.findCandidates({ ...query, now });
    const freshStatics = freshRows.map((row) => toStatic(row));
    const recoveryTtl =
      freshStatics.length === 0
        ? jitteredTtlSeconds(
            SEARCH_CACHE_TTL_EMPTY_SECONDS,
            SEARCH_CACHE_TTL_JITTER_FRACTION,
          )
        : ttl;
    await this.cache.set(key, freshStatics, recoveryTtl);
    return freshStatics;
  }
}

/**
 * A row becomes its cacheable projection.
 */
function toStatic(row: TripSearchRow): CachedStaticTrip {
  return {
    tripId: row.tripId,
    trainNumber: row.trainNumber,
    trainTypeId: row.trainTypeId,
    trainTypeEn: row.trainTypeEn,
    trainTypeAr: row.trainTypeAr,
    travelClassNameEn: row.travelClassNameEn,
    travelClassNameAr: row.travelClassNameAr,
    originStationId: row.originStationId,
    originNameEn: row.originNameEn,
    originNameAr: row.originNameAr,
    destinationStationId: row.destinationStationId,
    destinationNameEn: row.destinationNameEn,
    destinationNameAr: row.destinationNameAr,
    originDepartureMillis: row.originDepartureAt.getTime(),
    destinationArrivalMillis: row.destinationArrivalAt.getTime(),
    durationMinutes: durationMinutesBetween(
      row.originDepartureAt,
      row.destinationArrivalAt,
    ),
    intermediateStops: row.intermediateStops,
    classCapacity: row.classCapacity,
    farePiastres: row.farePiastres,
  };
}
