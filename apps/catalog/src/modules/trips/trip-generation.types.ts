import { addCivilDays, cairoInstantOf } from '@app/contracts';

import type { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';

/** Share resolved stop instants between generation and publish validation. */
export interface TripStopDraft {
  station: TimetableStopEntity['station'];
  stationId: string;
  position: number;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

/** Resolve HH:mm and dayOffset into Cairo instants identically for generation and publication. */
export function resolveStopTimes(
  anchorDate: string,
  dayOffset: number,
  arrivalTime: string | null,
  departureTime: string | null,
): { arrivalAt: Date | null; departureAt: Date | null } {
  const stopDate = addCivilDays(anchorDate, dayOffset);

  return {
    arrivalAt: arrivalTime ? cairoInstantOf(stopDate, arrivalTime) : null,
    departureAt: departureTime ? cairoInstantOf(stopDate, departureTime) : null,
  };
}

/** One fare's amount and the instant it took effect. */
export interface FarePrice {
  effectiveFrom: Date;
  amountPiastres: number;
}

/** Every fare for a train, keyed by class and station pair, from one query. */
export type FareIndex = Map<string, FarePrice[]>;

export function fareKey(
  travelClassId: string,
  originStationId: string,
  destinationStationId: string,
): string {
  return `${travelClassId}|${originStationId}|${destinationStationId}`;
}
