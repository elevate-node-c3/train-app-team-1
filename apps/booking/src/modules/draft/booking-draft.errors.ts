import { status as GrpcStatus } from '@grpc/grpc-js';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';
import { decodeRefusal } from '@app/common';

export class BookingDraftError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly availableCount?: number,
    public readonly passengerRef?: string,
    public readonly maskedNationalId?: string,
  ) {
    super(message ?? code);
    this.name = 'BookingDraftError';
  }

  get details(): ValidationIssueRef[] {
    if (this.code === ErrorCode.PASSENGER_OVERLAP) {
      return [
        {
          field: 'passengerIds',
          rejectedValue:
            this.passengerRef && this.maskedNationalId
              ? {
                  passengerRef: this.passengerRef,
                  maskedNationalId: this.maskedNationalId,
                }
              : undefined,
          issueKey: 'ISSUE_PASSENGER_ALREADY_TRAVELLING',
          actionKey: 'ACTION_CHANGE_PASSENGER_OR_TRIP',
          params: { maskedNationalId: this.maskedNationalId ?? '' },
        },
      ];
    }
    if (this.code === ErrorCode.BOOKING_KEY_CONFLICT) {
      return [
        {
          field: 'bookingKey',
          rejectedValue: undefined,
          issueKey: 'ISSUE_IDEMPOTENCY_KEY_REUSED',
          actionKey: 'ACTION_SEND_NEW_IDEMPOTENCY_KEY',
        },
      ];
    }
    if (this.availableCount !== undefined) {
      return [
        {
          field: 'legs',
          rejectedValue: { availableCount: this.availableCount },
          issueKey: 'ISSUE_VALIDATION_FAILED',
          actionKey: 'ACTION_PICK_TRIP_FROM_RESULTS',
        },
      ];
    }
    return [];
  }
}

const BUSINESS_CODES = new Set<ErrorCode>([
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.BAD_REQUEST,
  ErrorCode.INVALID_PAYLOAD,
  ErrorCode.PASSENGER_NOT_FOUND,
  ErrorCode.INVALID_FULL_NAME,
  ErrorCode.INVALID_NATIONAL_ID_LENGTH,
  ErrorCode.INVALID_NATIONAL_ID_CENTURY,
  ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE,
  ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE,
  ErrorCode.INSUFFICIENT_SEATS,
  ErrorCode.SEAT_ALREADY_TAKEN,
  ErrorCode.SEAT_TAKEN,
  ErrorCode.PASSENGER_OVERLAP,
  ErrorCode.SALES_CLOSED,
  ErrorCode.HOLD_TERMINAL,
  ErrorCode.EXTENSION_NOT_ALLOWED,
  ErrorCode.BOOKING_KEY_CONFLICT,
  ErrorCode.HOLD_NOT_FOUND,
  ErrorCode.RESOURCE_NOT_FOUND,
  ErrorCode.FORBIDDEN,
]);

/**
 * What a downstream refusal means for this draft. decodeRefusal does the
 * parsing and the trusting; this adds only what booking needs to decide --
 * whether the outcome is definite, and the count or passenger the refusal
 * names, which now travel inside the detail refs like every other service's.
 */
export function extractErrorDetails(error: unknown): {
  code: ErrorCode;
  message: string;
  availableCount?: number;
  passengerRef?: string;
  definite: boolean;
} {
  const refusal = decodeRefusal(error);
  // A hold failure read back from the draft row is already decoded, and keeps
  // the count and ref as its own fields.
  const persisted = refusal ? null : persistedFailure(error);
  const knownCode = refusal?.code ?? persisted?.code;
  const code = knownCode ?? ErrorCode.DEPENDENCY_UNAVAILABLE;

  if (persisted) {
    return {
      code: persisted.code,
      message: persisted.code,
      availableCount: persisted.availableCount,
      passengerRef: persisted.passengerRef,
      definite: BUSINESS_CODES.has(persisted.code),
    };
  }

  return {
    // Our own failure and a dead dependency are the same thing from here: the
    // call may or may not have held seats, so the draft must reconcile.
    code:
      code === ErrorCode.INTERNAL_SERVER_ERROR ||
      code === ErrorCode.SERVICE_UNAVAILABLE
        ? ErrorCode.DEPENDENCY_UNAVAILABLE
        : code,
    message: code,
    availableCount: availableCountOf(refusal?.details ?? []),
    passengerRef: passengerRefOf(refusal?.details ?? []),
    definite: knownCode !== undefined && BUSINESS_CODES.has(knownCode),
  };
}

/** The shape rejectIntent stored: a code we already trusted, and its facts. */
function persistedFailure(error: unknown): {
  code: ErrorCode;
  availableCount?: number;
  passengerRef?: string;
} | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as Record<string, unknown>;
  if (
    typeof record.code !== 'string' ||
    !Object.values(ErrorCode).includes(record.code as ErrorCode)
  ) {
    return null;
  }

  const count = record.availableCount;
  return {
    code: record.code as ErrorCode,
    availableCount:
      typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
        ? count
        : undefined,
    passengerRef:
      typeof record.passengerRef === 'string' ? record.passengerRef : undefined,
  };
}

function rejectedValues(
  details: ValidationIssueRef[],
): Record<string, unknown>[] {
  return details
    .map((detail) => detail.rejectedValue)
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && !Array.isArray(value),
    );
}

function availableCountOf(details: ValidationIssueRef[]): number | undefined {
  for (const value of rejectedValues(details)) {
    const count = value.availableCount;
    if (
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count >= 0
    ) {
      return count;
    }
  }
  return undefined;
}

function passengerRefOf(details: ValidationIssueRef[]): string | undefined {
  for (const value of rejectedValues(details)) {
    if (typeof value.passengerRef === 'string') return value.passengerRef;
  }
  return undefined;
}

export function isMissingHold(error: unknown): boolean {
  const details = extractErrorDetails(error);
  return (
    details.code === ErrorCode.HOLD_NOT_FOUND ||
    (error !== null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === GrpcStatus.NOT_FOUND)
  );
}
