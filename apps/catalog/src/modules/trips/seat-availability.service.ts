import { Injectable, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  AVAILABILITY_TTL_JITTER_FRACTION,
  AVAILABILITY_TTL_SECONDS,
  jitteredTtlSeconds,
} from '../cache/catalog-cache.keys.js';

/**
 * One segment to price availability for: a trip, the two stations the
 * passenger actually travels between, and the class they asked for.
 */
export interface SegmentAvailabilityQuery {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  classCapacity: number;
}

/**
 * Key format for segment availability (§2.3, SEAT-4).
 * Lives under its own keys and is merged into results at read time.
 */
export function segmentAvailabilityCacheKey(params: {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
}): string {
  return [
    'catalog:availability',
    'v1',
    params.tripId,
    params.originStationId,
    params.destinationStationId,
    params.travelClassId,
  ].join(':');
}

/**
 * How many seats are available, behind one seam.
 *
 * Availability lives under its own keys (`catalog:availability:v1:...`) and
 * is merged into search results at read time. In Sprint 3, inventory's events
 * update just those keys: a seat sold never invalidates a results list, and
 * a timetable change never touches counts it did not affect (§2.3, SEAT-4).
 */
@Injectable()
export class SeatAvailabilityService {
  constructor(@Optional() private readonly cache?: CacheAsideService) {}

  /**
   * Seats available per trip, keyed by `tripId`.
   */
  async availabilityFor(
    segments: readonly SegmentAvailabilityQuery[],
  ): Promise<Map<string, number>> {
    if (segments.length === 0) {
      return new Map();
    }

    const result = new Map<string, number>();
    const missing: SegmentAvailabilityQuery[] = [];

    if (!this.cache) {
      // Direct fallback without cache
      for (const segment of segments) {
        result.set(segment.tripId, segment.classCapacity);
      }
      return result;
    }

    // 1. Batch read from Redis
    for (const segment of segments) {
      const key = segmentAvailabilityCacheKey(segment);
      const cached = await this.cache.get<number>(key);

      if (cached !== null && typeof cached === 'number') {
        this.cache.getMetrics?.()?.recordHit('availability');
        result.set(segment.tripId, cached);
      } else {
        this.cache.getMetrics?.()?.recordMiss('availability');
        missing.push(segment);
      }
    }

    // 2. Rebuild missing segments (provisional capacity; inventory in Sprint 3)
    if (missing.length > 0) {
      const ttl = jitteredTtlSeconds(
        AVAILABILITY_TTL_SECONDS,
        AVAILABILITY_TTL_JITTER_FRACTION,
      );

      for (const segment of missing) {
        const available = segment.classCapacity;
        result.set(segment.tripId, available);

        const key = segmentAvailabilityCacheKey(segment);
        await this.cache.set(key, available, ttl);
      }
    }

    return result;
  }
}
