/**
 * Stops depend only on the published timetable, so they can use longer TTLs.
 * Bound expiry until every republish path calls TripStopsService.invalidate;
 * expiry must eventually clear changed itineraries.
 */

export const TRIP_STOPS_TTL_SECONDS = 6 * 60 * 60;

/** Spread expiries to avoid synchronized refreshes. */
export const TRIP_STOPS_TTL_JITTER_FRACTION = 0.1;

/**
 * Use epoch milliseconds: JSON cannot round-trip Date objects.
 * Convert instants to Cairo civil time on every read.
 */
export interface CachedTripStop {
  stationId: string;
  stationNameEn: string;
  stationNameAr: string;
  /** Null at the boarding stop. */
  arrivalMillis: number | null;
  /** Null at the alighting stop. */
  departureMillis: number | null;
}

/** `catalog:trip-stops:v1:<tripId>:<from>:<to>` */
export function tripStopsCacheKey(params: {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
}): string {
  return [
    'catalog:trip-stops',
    // Change the key version when the payload shape changes.
    'v1',
    params.tripId,
    params.originStationId,
    params.destinationStationId,
  ].join(':');
}

/**
 * Jitter base seconds by up to fraction in either direction.
 * Inject randomness for deterministic band tests.
 */
export function jitteredTtlSeconds(
  base: number,
  fraction: number,
  random: () => number = Math.random,
): number {
  const offset = (random() * 2 - 1) * fraction;
  return Math.max(1, Math.round(base * (1 + offset)));
}

const STRING_FIELDS = ['stationId', 'stationNameEn', 'stationNameAr'] as const;

/**
 * Malformed or older cache shapes are misses, not errors.
 * Fetch from the database instead of returning undefined fields.
 */
export function isCachedTripStop(value: unknown): value is CachedTripStop {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  for (const field of STRING_FIELDS) {
    if (typeof candidate[field] !== 'string') return false;
  }

  for (const field of ['arrivalMillis', 'departureMillis'] as const) {
    const time = candidate[field];
    if (time !== null && typeof time !== 'number') return false;
  }

  return true;
}
