import type { CoachLayoutEntity } from '../trains/entities/coach-layout.entity.js';
import type { TrainEntity } from '../trains/entities/train.entity.js';
import type { TravelClassEntity } from '../trains/entities/travel-class.entity.js';

/**
 * Resolve known IDs from catalog, not the request, so existence checks are real.
 * Generation can trust its foreign-key-constrained rows instead.
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
 * Changed trips keep their IDs and replace stops, composition, and timetable
 * version in place. Withdraw only when a train stops running that day;
 * withdrawing a continuing trip would destroy inventory seats.
 */
export type TripChangeKind = 'created' | 'changed' | 'withdrawn';

export interface TripChange {
  serviceDate: string;
  kind: TripChangeKind;
  /** Null only for created trips. */
  tripId: string | null;
  /** True when the new version moves this trip's times or its stop set. */
  movesShape: boolean;
  /** Stations the trip stops at today and would not after the publish. */
  removedStationIds: string[];
}

/**
 * Compute counts before commit. A concurrent generator may insert trips before
 * application, making generation report fewer creations than the publish caused.
 */
export interface TimetableDiff {
  changes: TripChange[];
  created: number;
  changed: number;
  withdrawn: number;
}

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
