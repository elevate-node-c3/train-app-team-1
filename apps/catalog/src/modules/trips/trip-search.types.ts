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

/**
 * The outbound trip's own segment, as the return search reads it.
 *
 * The return list may not depart before `destinationArrivalAt` (BR-20) -- the
 * instant the outbound trip lands at what becomes the return origin -- and that
 * instant comes from here rather than from anything a client sent.
 * `originDepartureAt` is the outbound's own departure, and its Cairo civil date
 * is the earliest return date the server will accept.
 */
export interface PassengerSegmentRow {
  originStationId: string;
  destinationStationId: string;
  originDepartureAt: Date;
  destinationArrivalAt: Date;
  /** `YYYY-MM-DD` in Cairo, derived from `originDepartureAt`. */
  cairoDepartureDate: string;
}

/**
 * One stop on the passenger's own segment, in travel order.
 *
 * Both instants are whatever the timetable holds, not what the passenger uses:
 * a segment that alights mid-route keeps that stop's onward departure, because
 * the train does depart and hiding it would be a different claim. Only the
 * trip's own first and last stops are genuinely one-sided.
 */
export interface TripStopRow {
  stationId: string;
  stationNameEn: string;
  stationNameAr: string;
  /** Null at the trip's first stop, which nothing arrives at. */
  arrivalAt: Date | null;
  /** Null at the trip's last stop, which nothing departs from. */
  departureAt: Date | null;
}

/** What the probes found when a search came back empty. */
export interface RouteServedProbe {
  routeServed: boolean;
  trainServesRoute: boolean;
}
