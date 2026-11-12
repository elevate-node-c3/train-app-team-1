import type { CoachLayoutEntity } from '../trains/entities/coach-layout.entity.js';
import type { TrainEntity } from '../trains/entities/train.entity.js';
import type { TravelClassEntity } from '../trains/entities/travel-class.entity.js';

/**
 * What the catalogue actually holds for the ids a publish named.
 *
 * `knownStationIds` and `knownCoachLayoutIds` are the **real** sets, resolved
 * from the catalogue rather than built from the request's own ids. Trip
 * generation builds permissive sets from its own input, which is right there
 * -- its rows are already FK-constrained -- but a publish that did the same
 * would make the unknown-station and unknown-layout rules validate nothing.
 */
export interface PublishReferences {
  train: TrainEntity | null;
  knownStationIds: ReadonlySet<string>;
  knownCoachLayoutIds: ReadonlySet<string>;
  knownTravelClassIds: ReadonlySet<string>;
  /** Layouts the request named that exist, for the capacity and seat rules. */
  layoutsById: ReadonlyMap<string, CoachLayoutEntity>;
  classesById: ReadonlyMap<string, TravelClassEntity>;
}

/**
 * What one service date gains, keeps or loses.
 *
 * `changed` is re-pointed **in place**: the dated trip keeps its id, its stops
 * and composition are rewritten and its `timetable_id` moves to the new
 * version. It is deliberately not "withdrawn then created" -- withdrawing
 * destroys inventory's seats for a train that still runs, and `TripWithdrawn`
 * is reserved for a train that genuinely stops running that day.
 */
export type TripChangeKind = 'created' | 'changed' | 'withdrawn';

export interface TripChange {
  serviceDate: string;
  kind: TripChangeKind;
  /** Null exactly when `kind` is 'created': there is no trip yet. */
  tripId: string | null;
  /** True when the new version moves this trip's times or its stop set. */
  movesShape: boolean;
  /** Stations the trip stops at today and would not after the publish. */
  removedStationIds: string[];
}

/**
 * The whole answer to "what would this publish do", computed before anything
 * is written. The counts the operator is told come from here, never from the
 * return values of the generation calls that apply it -- `TripsService`
 * generates on a timer and can insert the new version's trips between the
 * commit and the apply pass, which would report `created: 0` for trips this
 * publish caused.
 */
export interface TimetableDiff {
  changes: TripChange[];
  created: number;
  changed: number;
  withdrawn: number;
}

/** One version's shape, as the audit trail records it. */
export interface TimetableVersionSnapshot {
  timetableId: string;
  version: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  runningDays: number[];
  stops: {
    stationId: string;
    position: number;
    dayOffset: number;
    arrivalTime: string | null;
    departureTime: string | null;
  }[];
}
