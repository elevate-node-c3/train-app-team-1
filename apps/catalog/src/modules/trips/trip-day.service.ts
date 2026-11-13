import { Injectable, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import { durationMinutesBetween } from '@app/contracts';

import { jitteredTtlSeconds } from '../cache/catalog-cache.keys.js';
import { RouteVersionService } from '../cache/route-version.service.js';
import {
  cacheTtlSecondsFor,
  isCachedStaticTrip,
  SEARCH_CACHE_TTL_EMPTY_SECONDS,
  SEARCH_CACHE_TTL_JITTER_FRACTION,
  searchCacheKey,
  type CachedStaticTrip,
} from './trip-search-cache.js';
import { TripSearchRepository } from './trip-search.repository.js';
import type { TripSearchRow } from './trip-search.types.js';

/** Both search legs share this route/date/class query. */
export interface TripDayQuery {
  originStationId: string;
  destinationStationId: string;
  /** The Cairo civil date being searched, 'YYYY-MM-DD'. */
  serviceDate: string;
  travelClassId: string;
  /** Null means "any train". */
  trainNumber: number | null;
}

/** Share the cached static day between outbound and return searches. */
@Injectable()
export class TripDayService {
  constructor(
    private readonly trips: TripSearchRepository,
    private readonly cache: CacheAsideService,
    @Optional() private readonly routeVersion?: RouteVersionService,
  ) {}

  /** Treat malformed cache payloads as misses, not partial responses. */
  async staticTripsFor(
    query: TripDayQuery,
    now: Date,
  ): Promise<CachedStaticTrip[]> {
    // Capture version before querying so invalidation during rebuild makes this key stale.
    const capturedVersion = this.routeVersion
      ? await this.routeVersion.getRouteVersion(
          query.originStationId,
          query.destinationStationId,
        )
      : undefined;

    const key = searchCacheKey({ ...query, routeVersion: capturedVersion });
    const baseTtl = cacheTtlSecondsFor(query.serviceDate, now);
    const ttl = jitteredTtlSeconds(baseTtl, SEARCH_CACHE_TTL_JITTER_FRACTION);

    // Coalesce concurrent cold-key requests to prevent a cache stampede.
    const rebuild = async () => {
      const rows = await this.trips.findCandidates({ ...query, now });
      return rows.map((row) => toStatic(row));
    };

    let result: CachedStaticTrip[];
    if (typeof this.cache.getOrRebuild === 'function') {
      result = await this.cache.getOrRebuild<CachedStaticTrip[]>(
        key,
        'search',
        rebuild,
        ttl,
      );
    } else {
      const cached = await this.cache.get<unknown>(key);
      if (Array.isArray(cached) && cached.every(isCachedStaticTrip)) {
        result = cached;
      } else {
        result = await rebuild();
        await this.cache.set(key, result, ttl);
      }
    }

    if (Array.isArray(result) && result.every(isCachedStaticTrip)) {
      return result;
    }

    // Recover malformed cached data; use a shorter TTL for empty results.
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
