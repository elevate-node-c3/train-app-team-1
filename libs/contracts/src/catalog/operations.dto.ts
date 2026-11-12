/** The shapes an ENR operator's publish travels in (TA-20); no rules live here. */

/** A naive Cairo wall-clock time plus a day offset, never an instant. */
export interface PublishTimetableStopInput {
  stationId: string;
  /** Strictly increasing along the route; not necessarily contiguous. */
  position: number;
  /** 0 for the departure day, 1 for an overnight leg. */
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
 * A whole timetable for one train. `trainNumber` is a string because it is
 * echoed verbatim in a refusal; catalog parses it to the integer column.
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

/** Changes counted from the diff computed before anything was written. */
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
