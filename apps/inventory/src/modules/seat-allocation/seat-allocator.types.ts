import type { AllocationOutcome, AssignedSeat } from '@app/contracts';

/**
 * One seat of a trip, shaped exactly like a `trip_seat` row joined to its
 * `trip_coach`. The engine reads the schema's own columns rather than
 * rebuilding a layout, so adjacency here means the same thing it means in
 * the database.
 */
export interface AllocatableSeat {
  seatId: string;
  coachNumber: number;
  rowNumber: number;
  side: 'left' | 'right';
  seatIndexInSide: number;
  seatNumber: string;
}

export interface AllocateGroupSeatsInput {
  /** 1 to 4. */
  groupSize: number;
  /** Every seat of the trip and travel class, occupied or not. */
  seats: AllocatableSeat[];
  /** Seats blocked over the wanted segment; the rest are free. */
  occupiedSeatIds?: Iterable<string>;
  /** Mapped onto the assignments in order, when the caller knows them. */
  passengerIds?: string[];
}

export interface AllocatedSeatAssignment extends AssignedSeat {
  passengerId?: string;
}

export type AllocationResult =
  | {
      success: true;
      outcome: AllocationOutcome;
      seats: AllocatedSeatAssignment[];
    }
  | {
      success: false;
      error: 'INSUFFICIENT_SEATS';
      availableCount: number;
    };
