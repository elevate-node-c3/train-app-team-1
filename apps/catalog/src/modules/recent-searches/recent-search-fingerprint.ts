import type { RecentSearchInput } from './recent-searches.types.js';

/**
 * Identity is route, class, kind, and train number. Exclude dates so repeats
 * refresh dates and ordering without taking another of the traveller's five slots.
 * Include kind so one-way and round-trip searches remain distinct.
 * Use ':' separators and '*' for any train, matching searchCacheKey.
 * UUIDs, a known kind, and an integer are collision-free; keep them unhashed for debugging.
 */
export function fingerprintOf(
  search: Pick<
    RecentSearchInput,
    | 'originStationId'
    | 'destinationStationId'
    | 'travelClassId'
    | 'kind'
    | 'trainNumber'
  >,
): string {
  return [
    'v1',
    search.originStationId,
    search.destinationStationId,
    search.travelClassId,
    search.kind,
    search.trainNumber === null ? '*' : search.trainNumber,
  ].join(':');
}
