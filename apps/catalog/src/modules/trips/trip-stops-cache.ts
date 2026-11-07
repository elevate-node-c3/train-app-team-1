/**
 * What the stops endpoint caches, and for how long.
 *
 * Stops are a function of a published trip's timetable and nothing else, so
 * they can be cached longer than a search. The TTL stays bounded because
 * nothing republishes a timetable yet: `TripStopsService.invalidate` is the
 * intended hook for TA-16's republish path, and until it has a caller the
 * expiry is what eventually clears a changed itinerary.
 */

/** Six hours, before jitter. */
export const TRIP_STOPS_TTL_SECONDS = 6 * 60 * 60;

/** Enough spread to keep a fleet's entries from expiring in lockstep. */
export const TRIP_STOPS_TTL_JITTER_FRACTION = 0.1;

/**
 * One stop as stored.
 *
 * Instants are epoch milliseconds rather than `Date` for the same reason as
 * search's payload: JSON has no date type, and a rehydrated `Date` would be a
 * string. The service converts them to Cairo civil time on every read.
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
    // Versioned like search: a shape change is a new key, not a payload the
    // new code misreads.
    'v1',
    params.tripId,
    params.originStationId,
    params.destinationStationId,
  ].join(':');
}

/**
 * `base` seconds with up to `fraction` shaved off or added.
 *
 * `random` is injectable so the band can be tested without relying on the
 * clock or on statistical luck.
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
 * Whether a decoded cache entry is one of ours.
 *
 * Same rule as search's guard: a payload from an older deploy parses as JSON
 * and then lacks a field, which would put `undefined` into a stop list. A
 * failure is a miss, so the answer stays correct and merely costs a query.
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
