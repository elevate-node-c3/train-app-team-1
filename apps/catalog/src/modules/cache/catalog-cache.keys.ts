/**
 * Centralized key catalog and TTL specifications for Catalog service (§2.3 rule 2).
 *
 * Every key has an owner, a TTL band with jitter, and an invalidation trigger.
 */

/** Search results: 5 minutes base TTL for future dates */
export const SEARCH_CACHE_TTL_SECONDS = 300;

/** Search results: 60 seconds base TTL for today */
export const SEARCH_CACHE_TTL_TODAY_SECONDS = 60;

/** Search results: 60 seconds base TTL for empty result sets */
export const SEARCH_CACHE_TTL_EMPTY_SECONDS = 60;

/** Trip search TTL jitter fraction (10%) */
export const SEARCH_CACHE_TTL_JITTER_FRACTION = 0.1;

/** Trip stops: 6 hours base TTL */
export const TRIP_STOPS_TTL_SECONDS = 6 * 60 * 60;
export const TRIP_STOPS_TTL_JITTER_FRACTION = 0.1;

/** Station catalog: 24 hours base TTL */
export const STATIONS_TTL_SECONDS = 24 * 60 * 60;
export const STATIONS_TTL_JITTER_FRACTION = 0.1;

/** Seat availability per segment: 60 seconds base TTL */
export const AVAILABILITY_TTL_SECONDS = 60;
export const AVAILABILITY_TTL_JITTER_FRACTION = 0.1;

/**
 * Calculates a jittered TTL within `base * (1 ± fraction)`.
 */
export function jitteredTtlSeconds(
  base: number,
  fraction = 0.1,
  random: () => number = Math.random,
): number {
  const offset = (random() * 2 - 1) * fraction;
  return Math.max(1, Math.round(base * (1 + offset)));
}

