import type { SearchSort } from '@app/contracts';

/**
 * Default to ascending origin departure for absent or unknown sorts, including
 * orders from newer clients. Sort in memory without extra queries or cache keys.
 */

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

    default:
      return byDeparture;
  }
}

function fareOrInfinity(trip: SortableTrip): number {
  return trip.farePiastres ?? Number.POSITIVE_INFINITY;
}

/** Break time ties by train number and trip ID for deterministic results. */
function compareIdentifiers(left: SortableTrip, right: SortableTrip): number {
  return (
    left.trainNumber - right.trainNumber ||
    left.tripId.localeCompare(right.tripId)
  );
}
