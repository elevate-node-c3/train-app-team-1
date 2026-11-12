/** Keep shared types outside repositories, which export only their concrete class. */

/**
 * Raw rows have no time conversion, money formatting, or eligibility checks.
 * Repositories use bounded queries; services produce the wire shape.
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
 * Returns cannot depart before the server-read destinationArrivalAt.
 * The outbound originDepartureAt's Cairo date is the earliest accepted return date.
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
 * Preserve timetable arrivals and departures, including onward departures where
 * the passenger alights mid-route. Only the trip's first and last stops are one-sided.
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

export interface RouteServedProbe {
  routeServed: boolean;
  trainServesRoute: boolean;
}
