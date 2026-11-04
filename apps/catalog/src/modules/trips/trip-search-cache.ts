import { cairoToday } from '@app/contracts';

/**
 * What search caches, and under what key.
 *
 * All of the policy lives here rather than in the shared `CacheAsideService`,
 * so TA-19 can replace the mechanism without touching any of these decisions.
 */

/** Future dates: long enough to absorb a repeat-search burst. */
export const SEARCH_CACHE_TTL_SECONDS = 300;

/**
 * Today: shorter, because today's list is the one that changes under the
 * traveller as trips depart. It is not a correctness device -- eligibility is
 * re-applied on every read -- it only bounds how long a trip that has fallen
 * off the list lingers in the cached payload.
 */
export const SEARCH_CACHE_TTL_TODAY_SECONDS = 60;

/**
 * The static projection of one search result.
 *
 * Deliberately everything that is a function of the data and the Cairo date
 * alone, and nothing that is a function of `now` or of inventory. Availability,
 * sold-out, sales state and the date strip are all absent: they are computed
 * on every read, hit or miss.
 *
 * That exclusion is what makes two promises structural rather than remembered.
 * A list cached at 13:50 cannot offer, at 14:00, a trip whose sales closed at
 * 13:55 -- the cached payload does not know anything about sales. And Sprint
 * 3's real per-segment inventory changes where a number comes from without
 * changing a single cache key, because availability was never a key input or a
 * stored value.
 *
 * Instants are epoch milliseconds, not `Date`: JSON has no date type, so a
 * `Date` would return as a string and the eligibility filter compares numbers.
 */
export interface CachedStaticTrip {
  tripId: string;
  trainNumber: number;
  trainTypeEn: string;
  trainTypeAr: string;
  travelClassNameEn: string;
  travelClassNameAr: string;
  originStationId: string;
  originNameEn: string;
  originNameAr: string;
  destinationStationId: string;
  destinationNameEn: string;
  destinationNameAr: string;
  originDepartureMillis: number;
  destinationArrivalMillis: number;
  durationMinutes: number;
  intermediateStops: number;
  classCapacity: number;
  farePiastres: number | null;
}

/**
 * The key for one search.
 *
 * `v1` is a format version: a change to `CachedStaticTrip` becomes a new key
 * rather than a payload today's code cannot read. The segments are uuids and a
 * civil date, already opaque and collision-free, so nothing is hashed.
 *
 * Station ids are not sorted. Direction is part of the search's identity --
 * Tanta to Banha and Banha to Tanta are different journeys, and on a one-way
 * route one of them has no answer at all.
 */
export function searchCacheKey(params: {
  originStationId: string;
  destinationStationId: string;
  serviceDate: string;
  travelClassId: string;
  trainNumber: number | null;
}): string {
  // '*' rather than an empty segment, so "any train" cannot render the same as
  // a train number and cannot produce two adjacent colons.
  const trainNumber = params.trainNumber === null ? '*' : params.trainNumber;

  return [
    'catalog:search',
    'v1',
    params.originStationId,
    params.destinationStationId,
    params.serviceDate,
    params.travelClassId,
    trainNumber,
  ].join(':');
}

/** How long this date's answer may be kept. */
export function cacheTtlSecondsFor(serviceDate: string, now: Date): number {
  return serviceDate === cairoToday(now)
    ? SEARCH_CACHE_TTL_TODAY_SECONDS
    : SEARCH_CACHE_TTL_SECONDS;
}

const NUMBER_FIELDS = [
  'trainNumber',
  'originDepartureMillis',
  'destinationArrivalMillis',
  'durationMinutes',
  'intermediateStops',
  'classCapacity',
] as const;

const STRING_FIELDS = [
  'tripId',
  'trainTypeEn',
  'trainTypeAr',
  'travelClassNameEn',
  'travelClassNameAr',
  'originStationId',
  'originNameEn',
  'originNameAr',
  'destinationStationId',
  'destinationNameEn',
  'destinationNameAr',
] as const;

/**
 * Whether a decoded cache entry is actually one of ours.
 *
 * A payload written by an older deploy parses as JSON and then quietly lacks a
 * field, which would put `undefined` into a traveller's search results. The
 * version in the key makes that unlikely; this makes it impossible. A failure
 * here is treated as a miss, so the answer is still correct, just slower.
 */
export function isCachedStaticTrip(value: unknown): value is CachedStaticTrip {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  for (const field of NUMBER_FIELDS) {
    if (typeof candidate[field] !== 'number') return false;
  }
  for (const field of STRING_FIELDS) {
    if (typeof candidate[field] !== 'string') return false;
  }

  // A real trip can have no fare -- the service drops it as unsellable -- so
  // null is valid here and only a wrong type is not.
  const fare = candidate.farePiastres;
  return fare === null || typeof fare === 'number';
}
