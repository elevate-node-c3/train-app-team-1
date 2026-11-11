import type { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';

/**
 * A trip stop resolved onto one service date: real instants, not timetable
 * strings. Shared so the publish validator can check the same shape
 * generation builds, rather than a second copy that could drift.
 */
export interface TripStopDraft {
  station: TimetableStopEntity['station'];
  stationId: string;
  position: number;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

/** One fare's amount and the instant it took effect. */
export interface FarePrice {
  effectiveFrom: Date;
  amountPiastres: number;
}

/**
 * Every fare a train carries, keyed by class and station pair. Built from one
 * query so validating a trip costs no round trip per pair.
 */
export type FareIndex = Map<string, FarePrice[]>;

export function fareKey(
  travelClassId: string,
  originStationId: string,
  destinationStationId: string,
): string {
  return `${travelClassId}|${originStationId}|${destinationStationId}`;
}
