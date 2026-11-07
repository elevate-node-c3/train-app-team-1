/**
 * The shapes the search path passes between its pieces.
 *
 * They live here rather than beside the repository because more than one thing
 * consumes them -- the service maps a row onto the wire, and the cache stores
 * a projection of one -- and because a `*.repository.ts` is required to export
 * nothing but its concrete class.
 */

/**
 * One candidate trip, as the query returns it.
 *
 * Deliberately raw: no time conversion, no money formatting, no eligibility.
 * The repository's job is to get the right set of rows in a bounded number of
 * statements; the service turns them into the wire shape.
 */
export interface TripSearchRow {
  tripId: string;
  trainNumber: number;
  trainTypeId: string;
  trainTypeEn: string;
  trainTypeAr: string;
  originStationId: string;
  originNameEn: string;
  originNameAr: string;
  originDepartureAt: Date;
  destinationStationId: string;
  destinationNameEn: string;
  destinationNameAr: string;
  destinationArrivalAt: Date;
  travelClassNameEn: string;
  travelClassNameAr: string;
  /** Stops strictly between the two endpoints. */
  intermediateStops: number;
  /** Seats of the requested class on this trip, from the published snapshot. */
  classCapacity: number;
  /** Null when no fare covers this segment: the trip cannot be sold. */
  farePiastres: number | null;
}

/** One stop on the passenger's own segment, in travel order. */
export interface TripStopRow {
  stationId: string;
  stationNameEn: string;
  stationNameAr: string;
  /** Null at the boarding stop. */
  arrivalAt: Date | null;
  /** Null at the alighting stop. */
  departureAt: Date | null;
}

/** What the probes found when a search came back empty. */
export interface RouteServedProbe {
  routeServed: boolean;
  trainServesRoute: boolean;
}
