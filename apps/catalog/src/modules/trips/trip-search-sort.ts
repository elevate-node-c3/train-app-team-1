import type { SearchSort } from '@app/contracts';

/**
 * Ordering one day's results (BR-18, CAT-4).
 *
 * The default is departure from the passenger's origin, ascending. That is
 * also what an absent sort decodes to, so a client that has never heard of the
 * other orders keeps the response it has always had. Unknown values fall back
 * to it as well: an older server must not reject a newer client's order.
 *
 * Pure and in memory: these run over the list the query already produced, so
 * changing the order never changes the cache key or adds a statement.
 */

/** The fields this module needs from a cacheable trip. */
export interface SortableTrip {
  tripId: string;
  trainNumber: number;
  originDepartureMillis: number;
  destinationArrivalMillis: number;
  durationMinutes: number;
  /** Null only before the sellability filter; treated as the most expensive. */
  farePiastres: number | null;
}

type Comparator<T> = (left: T, right: T) => number;

export function sortTrips<T extends SortableTrip>(
  trips: readonly T[],
  sort: SearchSort | undefined,
): T[] {
  return [...trips].sort(comparatorFor(sort));
}

function comparatorFor<T extends SortableTrip>(
  sort: SearchSort | undefined,
): Comparator<T> {
  const byDeparture = (left: T, right: T): number =>
    left.originDepartureMillis - right.originDepartureMillis ||
    compareIdentifiers(left, right);

  switch (sort) {
    case 'SEARCH_SORT_DURATION_ASC':
      return (left, right) =>
        left.durationMinutes - right.durationMinutes ||
        byDeparture(left, right);

    case 'SEARCH_SORT_FARE_ASC':
      return (left, right) =>
        fareOrInfinity(left) - fareOrInfinity(right) ||
        byDeparture(left, right);

    case 'SEARCH_SORT_ARRIVAL_ASC':
      return (left, right) =>
        left.destinationArrivalMillis - right.destinationArrivalMillis ||
        byDeparture(left, right);

    // UNSPECIFIED, DEPARTURE_ASC, and anything a newer client invented.
    default:
      return byDeparture;
  }
}

function fareOrInfinity(trip: SortableTrip): number {
  return trip.farePiastres ?? Number.POSITIVE_INFINITY;
}

/**
 * A deterministic last resort. Two trips can share a departure time, and a
 * response that reorders between calls is hard to test and worse to diff.
 */
function compareIdentifiers(left: SortableTrip, right: SortableTrip): number {
  return (
    left.trainNumber - right.trainNumber ||
    left.tripId.localeCompare(right.tripId)
  );
}
