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
 * Share filtering, sellability, sorting, and mapping rules between both legs.
 * Apply each leg's filters separately with already-batched seat counts; no queries here.
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
   * Notify the caller for each unpriced trip dropped; missing prices are data gaps
   * that the caller should log.
   */
  onUnpriced?: (trip: CachedStaticTrip) => void;
}

export interface TripList {
  trips: TripResult[];
  /**
   * Count filter survivors before unpriced trips are dropped, so callers can
   * distinguish filter-empty results from an empty day.
   */
  filteredCount: number;
}

export function buildTripList(input: TripListInput): TripList {
  // Reuse batched seat counts for sold-out filtering; no extra query.
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
      toTripResult(
        trip,
        input.travelClassId,
        input.seats.get(trip.tripId) ?? 0,
      ),
    ),
    filteredCount: filtered.length,
  };
}

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
    // Return sold-out trips and mark them; never hide them.
    soldOut: availableSeats === 0,
    fare: {
      // buildTripList must remove unpriced trips before mapping.
      amountMinor: trip.farePiastres ?? 0,
      currency: FARE_CURRENCY,
    },
  };
}
