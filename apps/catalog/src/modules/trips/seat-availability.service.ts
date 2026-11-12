import { Injectable, Optional } from '@nestjs/common';
import { CacheAsideService } from '@app/common';
import {
  AVAILABILITY_TTL_JITTER_FRACTION,
  AVAILABILITY_TTL_SECONDS,
  jitteredTtlSeconds,
} from '../cache/catalog-cache.keys.js';

export interface SegmentAvailabilityQuery {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  classCapacity: number;
}

/** Keep availability in separate keys and merge it into results at read time. */
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
 * Inventory events should update availability keys, not search lists; timetable
 * changes should affect only relevant counts. Inventory integration is pending,
 * so misses use provisional class capacity.
 */
@Injectable()
export class SeatAvailabilityService {
  constructor(@Optional() private readonly cache?: CacheAsideService) {}

  /** Available seats keyed by tripId. */
  async availabilityFor(
    segments: readonly SegmentAvailabilityQuery[],
  ): Promise<Map<string, number>> {
    if (segments.length === 0) {
      return new Map();
    }

    const result = new Map<string, number>();
    const missing: SegmentAvailabilityQuery[] = [];

    if (!this.cache) {
      // Without cache, use provisional class capacity until inventory is connected.
      for (const segment of segments) {
        result.set(segment.tripId, segment.classCapacity);
      }
      return result;
    }

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

    // Use provisional capacity until inventory integration is available.
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
