import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

/**
 * A hold business refusal. Transport adapters map the code to gRPC/HTTP;
 * repositories and the service never expose SQL or token details.
 */
export class HoldCoreError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly availableCount?: number,
    readonly passengerRef?: string,
  ) {
    super(message ?? code);
    this.name = 'HoldCoreError';
  }

  /**
   * What the caller can act on, as keys the edge resolves into Arabic or
   * English. The count and the passenger ref travel here rather than as
   * envelope fields of their own, so every service answers in one shape.
   */
  get details(): ValidationIssueRef[] {
    switch (this.code) {
      case ErrorCode.INSUFFICIENT_SEATS:
        return [
          {
            field: 'legs',
            rejectedValue:
              this.availableCount === undefined
                ? undefined
                : { availableCount: this.availableCount },
            issueKey: 'ISSUE_NOT_ENOUGH_SEATS_ON_TRAIN',
            actionKey: 'ACTION_FEWER_PASSENGERS_OR_ANOTHER_CLASS',
          },
        ];
      case ErrorCode.SEAT_TAKEN:
      case ErrorCode.SEAT_ALREADY_TAKEN:
        return [
          {
            field: 'legs',
            rejectedValue: undefined,
            issueKey: 'ISSUE_SEATS_JUST_TAKEN',
            actionKey: 'ACTION_PICK_ANOTHER_TRAIN_OR_CLASS',
          },
        ];
      case ErrorCode.PASSENGER_OVERLAP:
        // The ref, never the national ID: inventory does not hold one.
        return [
          {
            field: 'passengerRefs',
            rejectedValue:
              this.passengerRef === undefined
                ? undefined
                : { passengerRef: this.passengerRef },
            issueKey: 'ISSUE_PASSENGER_ALREADY_BOOKED',
            actionKey: 'ACTION_REMOVE_PASSENGER_OR_PICK_ANOTHER_TRAIN',
          },
        ];
      case ErrorCode.SALES_CLOSED:
        return [
          {
            field: 'legs',
            rejectedValue: undefined,
            issueKey: 'ISSUE_SALES_CLOSED_FOR_TRAIN',
            actionKey: 'ACTION_PICK_ANOTHER_TRAIN',
          },
        ];
      default:
        return [];
    }
  }
}
