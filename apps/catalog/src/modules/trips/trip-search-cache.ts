import { cairoToday } from '@app/contracts';
import {
  jitteredTtlSeconds,
  SEARCH_CACHE_TTL_EMPTY_SECONDS,
  SEARCH_CACHE_TTL_JITTER_FRACTION,
  SEARCH_CACHE_TTL_SECONDS,
  SEARCH_CACHE_TTL_TODAY_SECONDS,
} from '../cache/catalog-cache.keys.js';

export {
  SEARCH_CACHE_TTL_SECONDS,
  SEARCH_CACHE_TTL_TODAY_SECONDS,
  SEARCH_CACHE_TTL_EMPTY_SECONDS,
  SEARCH_CACHE_TTL_JITTER_FRACTION,
};

/**
 * The static projection of one search result.
 *
 * Deliberately everything that is a function of the data and the Cairo date
 * alone, and nothing that is a function of `now` or of inventory. Availability,
 * sold-out, sales state and the date strip are all absent: they are computed
 * on every read, hit or miss.
 */
export interface CachedStaticTrip {
  tripId: string;
  trainNumber: number;
  trainTypeId: string;
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
 * `v2` is a format version. When `routeVersion` is provided, includes `rv<routeVersion>`
 * for O(1) bulk invalidation (§6.3, §2.3 rule 2 & rule 5).
 */
export function searchCacheKey(params: {
  originStationId: string;
  destinationStationId: string;
  serviceDate: string;
  travelClassId: string;
  trainNumber: number | null;
  routeVersion?: number;
}): string {
  const trainNumber = params.trainNumber === null ? '*' : params.trainNumber;
  const parts = [
    'catalog:search',
    'v2',
    params.originStationId,
    params.destinationStationId,
    params.serviceDate,
    params.travelClassId,
    trainNumber,
  ];

  if (params.routeVersion !== undefined && params.routeVersion !== null) {
    parts.push(`rv${params.routeVersion}`);
  }

  return parts.join(':');
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
  'trainTypeId',
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

  const fare = candidate.farePiastres;
  return fare === null || typeof fare === 'number';
}
