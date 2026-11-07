import type { RecentSearchInput } from './recent-searches.types.js';

/**
 * What makes two searches the same one (BR-21).
 *
 * The decision: route, seat class, one way or round trip, and train number.
 * **Dates are deliberately excluded.** A traveller who searches Cairo to
 * Alexandria again with new dates is repeating a search, not making a new one,
 * so the existing row moves to the top carrying its new dates rather than
 * taking a second of their five slots.
 *
 * The kind IS included, because the story says so and because the two are not
 * interchangeable: repeating a one-way entry cannot give back the round trip a
 * traveller actually searched for.
 *
 * Joined with ':' and '*' for an absent train number, the same spelling
 * `searchCacheKey` uses for "any train" -- two adjacent colons would make
 * "no train" and some future empty value collide, and the whole point of this
 * string is that two different searches can never produce it.
 *
 * No hash. The parts are uuids, a short enum and an integer: already opaque,
 * already collision-free, and a hash would only make a debugging session
 * harder.
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
