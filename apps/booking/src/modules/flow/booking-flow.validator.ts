import { ErrorCode, type SubmitBookingRequest } from '@app/contracts';

import { BookingFlowError } from './booking-flow-error.js';

/** One booking carries one to four passengers (BR-28, D5). */
export const MAX_PASSENGERS = 4;

/** One outbound leg, or an outbound and a return. */
export const MAX_LEGS = 2;

/**
 * Each refusal names its own problem (BR-28, BR-57). Pure: nothing is read,
 * resolved or held before a submission is known to be well formed.
 */
export function validateSubmit(request: SubmitBookingRequest): void {
  const legs = request.legs ?? [];
  const passengerIds = request.passengerIds ?? [];

  if (!request.idempotencyKey) {
    throw new BookingFlowError(ErrorCode.VALIDATION_ERROR, [
      {
        field: 'idempotencyKey',
        rejectedValue: String(request.idempotencyKey ?? ''),
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ]);
  }
  if (!request.travelClassId) {
    throw new BookingFlowError(ErrorCode.VALIDATION_ERROR, [
      {
        field: 'travelClassId',
        rejectedValue: String(request.travelClassId ?? ''),
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ]);
  }
  if (legs.length === 0 || legs.length > MAX_LEGS) {
    throw new BookingFlowError(ErrorCode.VALIDATION_ERROR, [
      {
        field: 'legs',
        rejectedValue: String(legs.length),
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ]);
  }
  if (passengerIds.length === 0) {
    throw new BookingFlowError(ErrorCode.PASSENGERS_REQUIRED);
  }
  if (passengerIds.length > MAX_PASSENGERS) {
    throw new BookingFlowError(ErrorCode.TOO_MANY_PASSENGERS);
  }
  if (new Set(passengerIds).size !== passengerIds.length) {
    throw new BookingFlowError(ErrorCode.DUPLICATE_PASSENGER);
  }
}

/**
 * A repeated submit must resume the booking it already made, so a retry is
 * never refused by a later passenger edit. A key reused for different content
 * is a conflict, not a resume.
 */
export function isSameSubmission(
  stored: {
    travelClassId: string | null;
    bookingLegs: { tripId: string }[];
    holdIntent: { passengerRefs: string[] } | null;
  },
  request: SubmitBookingRequest,
): boolean {
  return (
    stored.travelClassId === request.travelClassId &&
    JSON.stringify(stored.bookingLegs.map((leg) => leg.tripId)) ===
      JSON.stringify(request.legs.map((leg) => leg.tripId)) &&
    JSON.stringify(stored.holdIntent?.passengerRefs ?? []) ===
      JSON.stringify(request.passengerIds)
  );
}
