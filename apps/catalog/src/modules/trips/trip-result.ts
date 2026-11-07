import {
  FARE_CURRENCY,
  civilDateTimeOf,
  type SearchFilters,
  type SearchSort,
  type TripResult,
} from '@app/contracts';

import { applyFilters } from './trip-search-filters.js';
import { sortTrips } from './trip-search-sort.js';
import type { CachedStaticTrip } from './trip-search-cache.js';

/**
 * Turning a day's eligible trips into the list a traveller sees.
 *
 * Both legs of a round trip end the same way -- narrow, drop what cannot be
 * sold, order, map -- and they have to, because "filters apply to each list
 * separately" means separately *applied*, not differently defined. Sharing the
 * code is what keeps the return list from quietly sorting or filtering by
 * another rule than the outbound one.
 *
 * Pure: the seats are passed in, already fetched in one batched call.
 */

export interface TripListInput {
  /** Post-eligibility, pre-filter: the day as this request found it. */
  eligible: readonly CachedStaticTrip[];
  /** Seats per trip id, from `SeatAvailabilityService`. */
  seats: Map<string, number>;
  travelClassId: string;
  filters?: SearchFilters;
  sort?: SearchSort;
  /**
   * Called for each trip dropped for having no fare. A sellable trip without a
   * price is a data gap someone should fix rather than a normal state, and the
   * caller owns the logger.
   */
  onUnpriced?: (trip: CachedStaticTrip) => void;
}

export interface TripList {
  trips: TripResult[];
  /**
   * How many survived the filters, before the unpriced ones were dropped.
   *
   * The caller needs it to tell "the filters emptied this list" from "the day
   * had nothing to begin with" -- two empty results that ask the traveller to
   * change different things (BR-57).
   */
  filteredCount: number;
}

export function buildTripList(input: TripListInput): TripList {
  // The availability call the response already needs answers the sold-out
  // filter too, so applying it adds no query.
  const soldOutTripIds = new Set(
    input.eligible
      .filter((trip) => (input.seats.get(trip.tripId) ?? 0) === 0)
      .map((trip) => trip.tripId),
  );

  const filtered = applyFilters(input.eligible, input.filters, soldOutTripIds);

  const priced = filtered.filter((trip) => {
    if (trip.farePiastres !== null) return true;
    input.onUnpriced?.(trip);
    return false;
  });

  return {
    trips: sortTrips(priced, input.sort).map((trip) =>
      toTripResult(trip, input.travelClassId, input.seats.get(trip.tripId) ?? 0),
    ),
    filteredCount: filtered.length,
  };
}

/** One static trip on the wire, for the class the traveller asked for. */
export function toTripResult(
  trip: CachedStaticTrip,
  travelClassId: string,
  availableSeats: number,
): TripResult {
  return {
    tripId: trip.tripId,
    trainNumber: trip.trainNumber,
    trainType: { en: trip.trainTypeEn, ar: trip.trainTypeAr },
    travelClass: {
      id: travelClassId,
      name: { en: trip.travelClassNameEn, ar: trip.travelClassNameAr },
    },
    departure: {
      stationId: trip.originStationId,
      name: { en: trip.originNameEn, ar: trip.originNameAr },
      at: civilDateTimeOf(new Date(trip.originDepartureMillis)),
    },
    arrival: {
      stationId: trip.destinationStationId,
      name: { en: trip.destinationNameEn, ar: trip.destinationNameAr },
      at: civilDateTimeOf(new Date(trip.destinationArrivalMillis)),
    },
    durationMinutes: trip.durationMinutes,
    intermediateStops: trip.intermediateStops,
    availableSeats,
    // Returned and marked, never hidden (BR-16).
    soldOut: availableSeats === 0,
    fare: {
      // Non-null by the time a trip reaches here; buildTripList dropped the rest.
      amountMinor: trip.farePiastres ?? 0,
      currency: FARE_CURRENCY,
    },
  };
}
