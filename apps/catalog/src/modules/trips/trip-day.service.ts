import { Injectable } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import { durationMinutesBetween } from '@app/contracts';

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
 *
 * Extracted so the outbound and return legs cannot drift apart. A round trip's
 * return list is "the reverse route on the return date" -- which is a plain
 * day query, and must land on the *same* cache key any other search for that
 * day uses. Keeping the key, the TTL and the projection in one place is what
 * makes that structural rather than a thing two services both remember.
 *
 * Nothing here depends on `now` except the TTL: eligibility, availability and
 * the after-arrival bound are all applied by the caller on every read, hit or
 * miss, so the cached payload can never go stale in a way that matters.
 */
@Injectable()
export class TripDayService {
  constructor(
    private readonly trips: TripSearchRepository,
    private readonly cache: CacheAsideService,
  ) {}

  /**
   * A cached entry that does not match the current shape is treated as a miss:
   * it parses as JSON and would otherwise put `undefined` into a traveller's
   * results.
   */
  async staticTripsFor(
    query: TripDayQuery,
    now: Date,
  ): Promise<CachedStaticTrip[]> {
    const key = searchCacheKey(query);

    const cached = await this.cache.get<unknown[]>(key);
    if (Array.isArray(cached) && cached.every(isCachedStaticTrip)) {
      return cached;
    }

    const rows = await this.trips.findCandidates({ ...query, now });
    const statics = rows.map((row) => toStatic(row));

    await this.cache.set(
      key,
      statics,
      cacheTtlSecondsFor(query.serviceDate, now),
    );

    return statics;
  }
}

/**
 * A row becomes its cacheable projection.
 *
 * The duration is computed here, from the two instants, so it is right across
 * midnight and across a daylight-saving change -- and so it is computed once
 * rather than on every cache read.
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
