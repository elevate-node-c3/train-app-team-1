import { status as GrpcStatus } from '@grpc/grpc-js';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

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

/** Never copy upstream messages, SQL, tokens, or arbitrary JSON into an error. */
export function extractErrorDetails(error: unknown): {
  code: ErrorCode;
  message: string;
  availableCount?: number;
  passengerRef?: string;
  definite: boolean;
} {
  let record: Record<string, unknown> = {};
  if (error && typeof error === 'object') {
    const source = error as Record<string, unknown>;
    record = source;
    if (typeof source.details === 'string') {
      try {
        const parsed: unknown = JSON.parse(source.details);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        // Unstructured transport failures have an unknown allocation outcome.
      }
    } else if (
      source.details &&
      typeof source.details === 'object' &&
      !Array.isArray(source.details)
    ) {
      record = source.details as Record<string, unknown>;
    }
  }
  const knownCode =
    typeof record.code === 'string' &&
    Object.values(ErrorCode).includes(record.code as ErrorCode)
      ? (record.code as ErrorCode)
      : undefined;
  const code = knownCode ?? ErrorCode.DEPENDENCY_UNAVAILABLE;
  const availableCount =
    typeof record.availableCount === 'number' &&
    Number.isSafeInteger(record.availableCount) &&
    record.availableCount >= 0
      ? record.availableCount
      : undefined;
  return {
    code:
      code === ErrorCode.INTERNAL_SERVER_ERROR ||
      code === ErrorCode.SERVICE_UNAVAILABLE
        ? ErrorCode.DEPENDENCY_UNAVAILABLE
        : code,
    message: code,
    availableCount,
    passengerRef:
      typeof record.passengerRef === 'string' ? record.passengerRef : undefined,
    definite: knownCode !== undefined && BUSINESS_CODES.has(knownCode),
  };
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
