/**
 * The shapes an ENR operator's publish travels in (TA-20).
 *
 * Shapes only. Nothing fee-related, nothing price-deriving and no refusal
 * rules live here -- TA-72/BR-31 keep domain logic out of shared libraries,
 * and the publish's rules are catalog's (`timetable-publish.validator.ts`,
 * `timetable-publish.service.ts`). A reader of this file learns what a
 * request looks like and nothing about whether one would be accepted.
 */

/**
 * One planned stop, as submitted: naive Cairo wall-clock `'HH:mm'` plus a day
 * offset, never an instant. An operator publishes a timetable, not a day's
 * trip, so there is no date here -- `effectiveFrom` and each generated
 * service date supply it.
 */
export interface PublishTimetableStopInput {
  stationId: string;
  /** Strictly increasing along the route; not necessarily contiguous. */
  position: number;
  /** 0 for the departure day, 1 for an overnight leg, and so on. */
  dayOffset: number;
  /** Null at the first stop. */
  arrivalTime: string | null;
  /** Null at the last stop. */
  departureTime: string | null;
}

/** One coach of the composition the publish is validated against. */
export interface PublishTimetableCoachInput {
  position: number;
  coachNumber: number;
  travelClassId: string;
  coachLayoutId: string;
}

/** One fare the publish records, in integer piastres and excluding any fee. */
export interface PublishTimetableFareInput {
  travelClassId: string;
  originStationId: string;
  destinationStationId: string;
  amountPiastres: number;
}

/**
 * A whole timetable for one train, in one call.
 *
 * `trainNumber` is a string because it arrives from a URL path segment or a
 * JSON body and is echoed back verbatim in a refusal's `rejectedValue`; the
 * column it resolves against is an integer, and catalog does that parse.
 */
export interface PublishTimetableRequest {
  trainNumber: string;
  /** 0 = Sunday, matching `Date.getUTCDay()`. */
  runningDays: number[];
  /** 'YYYY-MM-DD', a Cairo civil date. */
  effectiveFrom: string;
  stops: PublishTimetableStopInput[];
  coaches: PublishTimetableCoachInput[];
  fares: PublishTimetableFareInput[];
}

/**
 * What the publish changed, counted from the diff catalog computed before it
 * wrote anything -- never from the rows the generation pass happened to
 * insert, which a background timer can race.
 */
export interface PublishTimetableResult {
  timetableId: string;
  version: number;
  /** Service dates that gained a trip. */
  created: number;
  /** Dated trips re-pointed in place, keeping their trip ids. */
  changed: number;
  /** Dated trips the new version no longer runs. */
  withdrawn: number;
}
