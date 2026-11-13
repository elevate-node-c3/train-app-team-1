import { randomUUID } from 'node:crypto';
import type { TripPublishedPayloadV1 } from '@app/contracts';

export interface PlannedStop {
  stationId: string;
  position: number;
  arrivalAt: Date | null;
  departureAt: Date | null;
}

export interface PlannedCoach {
  id: string;
  coachNumber: number;
  position: number;
  travelClassId: string;
  travelClassNameEn: string;
  travelClassNameAr: string;
}

export interface PlannedSeat {
  id: string;
  coachId: string;
  seatNumber: string;
  travelClassId: string;
  rowNumber: number;
  side: 'left' | 'right';
  seatIndexInSide: number;
}

export interface SeatPlan {
  tripId: string;
  trainId: string;
  trainNumber: number;
  serviceDate: string;
  timetableVersion: number;
  stops: PlannedStop[];
  coaches: PlannedCoach[];
  seats: PlannedSeat[];
  capacityMismatch: number | null;
}

function parseOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/** Catalog's positions need not be dense or start at zero; range math assumes they are. */
function plannedStopsFrom(payload: TripPublishedPayloadV1): PlannedStop[] {
  return [...payload.stops]
    .sort((a, b) => a.position - b.position)
    .map((stop, position) => ({
      stationId: stop.stationId,
      position,
      arrivalAt: parseOrNull(stop.arrivalAt),
      departureAt: parseOrNull(stop.departureAt),
    }));
}

/** Translates a publication into the rows Task 6 writes, in one shot and with every id pre-minted. */
export function seatPlanFrom(payload: TripPublishedPayloadV1): SeatPlan {
  const coaches: PlannedCoach[] = [];
  const seats: PlannedSeat[] = [];
  let actualCapacity = 0;

  for (const coach of payload.coaches) {
    const coachId = randomUUID();
    coaches.push({
      id: coachId,
      coachNumber: coach.coachNumber,
      position: coach.position,
      travelClassId: coach.travelClass.id,
      travelClassNameEn: coach.travelClass.nameEn,
      travelClassNameAr: coach.travelClass.nameAr,
    });

    for (const row of coach.coachLayout.rows) {
      row.leftSeats.forEach((seatNumber, seatIndexInSide) => {
        seats.push({
          id: randomUUID(),
          coachId,
          seatNumber,
          travelClassId: coach.travelClass.id,
          rowNumber: row.rowNumber,
          side: 'left',
          seatIndexInSide,
        });
      });
      row.rightSeats.forEach((seatNumber, seatIndexInSide) => {
        seats.push({
          id: randomUUID(),
          coachId,
          seatNumber,
          travelClassId: coach.travelClass.id,
          rowNumber: row.rowNumber,
          side: 'right',
          seatIndexInSide,
        });
      });
      actualCapacity += row.leftSeats.length + row.rightSeats.length;
    }
  }

  return {
    tripId: payload.tripId,
    trainId: payload.trainId,
    trainNumber: payload.trainNumber,
    serviceDate: payload.serviceDate,
    timetableVersion: payload.timetableVersion,
    stops: plannedStopsFrom(payload),
    coaches,
    seats,
    // The layout is the truth; capacity is only catalog's summary (spec §6.10).
    capacityMismatch: payload.capacity === actualCapacity ? null : payload.capacity,
  };
}
