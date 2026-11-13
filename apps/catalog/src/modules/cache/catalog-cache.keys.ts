/** Every cache key needs an owner, a jittered TTL, and an invalidation trigger. */

export const SEARCH_CACHE_TTL_SECONDS = 300;

export const SEARCH_CACHE_TTL_TODAY_SECONDS = 60;

export const SEARCH_CACHE_TTL_EMPTY_SECONDS = 60;

export const SEARCH_CACHE_TTL_JITTER_FRACTION = 0.1;

export const TRIP_STOPS_TTL_SECONDS = 6 * 60 * 60;
export const TRIP_STOPS_TTL_JITTER_FRACTION = 0.1;

/**
 * Station catalog: 24 hours base TTL, keyed per generation.
 *
 * `station.changed` bumps `catalog:stations:generation` rather than deleting
 * the entry, so a slow rebuild cannot write a stale list back after the
 * invalidation. The counter carries no TTL: it is the one key here whose
 * eviction costs correctness, not just a miss.
 */
export const STATIONS_TTL_SECONDS = 24 * 60 * 60;
export const STATIONS_TTL_JITTER_FRACTION = 0.1;

export const AVAILABILITY_TTL_SECONDS = 60;
export const AVAILABILITY_TTL_JITTER_FRACTION = 0.1;

/** Jitter stays within base * (1 +/- fraction). */
export function jitteredTtlSeconds(
  base: number,
  fraction = 0.1,
  random: () => number = Math.random,
): number {
  const offset = (random() * 2 - 1) * fraction;
  return Math.max(1, Math.round(base * (1 + offset)));
}

