import {
  AllocationOutcome,
  type HoldLegResult,
  type HoldSeatAssignment,
  type HoldSnapshot,
  type HoldState,
  type SplitNoticePayload,
} from '@app/contracts';

/**
 * What leaves inventory on a hold RPC, field by field.
 *
 * All four hold RPCs answer with a HoldSnapshot, so there is one response
 * shape. Each `from` copies named fields and never spreads its source: a row
 * that happens to carry passenger_token or an owner's National ID cannot ride
 * along into a response because someone widened a query.
 *
 * The repository already picks its fields, so this guards the boundary rather
 * than fixing a leak -- and it is the place a test can assert that only what
 * inventory.proto declares ever reaches a caller.
 */
export class SplitNoticeDto implements SplitNoticePayload {
  code!: string;
  /** Arabic, with messageEn beside it; a notice is not a refusal. */
  message!: string;
  messageEn!: string;

  static from(notice: SplitNoticePayload): SplitNoticeDto {
    return Object.assign(new SplitNoticeDto(), {
      code: notice.code,
      message: notice.message,
      messageEn: notice.messageEn,
    });
  }
}

export class HoldLegResultDto implements HoldLegResult {
  tripId!: string;
  travelClassId!: string;
  originStationId!: string;
  destinationStationId!: string;
  originPosition!: number;
  destinationPosition!: number;
  outcome!: AllocationOutcome;
  splitNotice?: SplitNoticeDto;

  static from(leg: HoldLegResult): HoldLegResultDto {
    return Object.assign(new HoldLegResultDto(), {
      tripId: leg.tripId,
      travelClassId: leg.travelClassId,
      originStationId: leg.originStationId,
      destinationStationId: leg.destinationStationId,
      originPosition: leg.originPosition,
      destinationPosition: leg.destinationPosition,
      outcome: leg.outcome,
      ...(leg.splitNotice === undefined
        ? {}
        : { splitNotice: SplitNoticeDto.from(leg.splitNotice) }),
    });
  }
}

export class HoldSeatAssignmentDto implements HoldSeatAssignment {
  /** Booking's reference, which is what inventory holds instead of a name. */
  passengerRef!: string;
  passengerKeyVersion!: number;
  tripId!: string;
  tripSeatId!: string;
  travelClassId!: string;
  coachNumber!: number;
  seatNumber!: string;
  rowNumber!: number;
  label?: string;
  outcome!: AllocationOutcome;
  originStationId!: string;
  destinationStationId!: string;
  originPosition!: number;
  destinationPosition!: number;

  static from(assignment: HoldSeatAssignment): HoldSeatAssignmentDto {
    return Object.assign(new HoldSeatAssignmentDto(), {
      passengerRef: assignment.passengerRef,
      passengerKeyVersion: assignment.passengerKeyVersion,
      tripId: assignment.tripId,
      tripSeatId: assignment.tripSeatId,
      travelClassId: assignment.travelClassId,
      coachNumber: assignment.coachNumber,
      seatNumber: assignment.seatNumber,
      rowNumber: assignment.rowNumber,
      ...(assignment.label === undefined ? {} : { label: assignment.label }),
      outcome: assignment.outcome,
      originStationId: assignment.originStationId,
      destinationStationId: assignment.destinationStationId,
      originPosition: assignment.originPosition,
      destinationPosition: assignment.destinationPosition,
    });
  }
}

export class HoldSnapshotResponseDto implements HoldSnapshot {
  holdId!: string;
  bookingKey!: string;
  ownerId!: string;
  state!: HoldState;
  version!: number;
  extensionUsed!: boolean;
  expiresAt!: string | null;
  serverNow!: string;
  allocationOutcome!: AllocationOutcome | null;
  legs!: HoldLegResultDto[];
  assignments!: HoldSeatAssignmentDto[];

  static from(snapshot: HoldSnapshot): HoldSnapshotResponseDto {
    return Object.assign(new HoldSnapshotResponseDto(), {
      holdId: snapshot.holdId,
      bookingKey: snapshot.bookingKey,
      ownerId: snapshot.ownerId,
      state: snapshot.state,
      version: snapshot.version,
      extensionUsed: snapshot.extensionUsed,
      expiresAt: snapshot.expiresAt,
      serverNow: snapshot.serverNow,
      allocationOutcome: snapshot.allocationOutcome,
      legs: snapshot.legs.map((leg) => HoldLegResultDto.from(leg)),
      assignments: snapshot.assignments.map((assignment) =>
        HoldSeatAssignmentDto.from(assignment),
      ),
    });
  }
}
