import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

/**
 * A refusal the flow decided, carrying the business code and the fields it is
 * about. Transport is not this type's concern: to-rpc-exception.ts turns it
 * into a status, exactly as catalog-search-error.ts does for catalog.
 */
export class BookingFlowError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly details: ValidationIssueRef[] = [],
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BookingFlowError';
  }
}

export function isBookingFlowError(error: unknown): error is BookingFlowError {
  return error instanceof BookingFlowError;
}

/** Internal failures that are nobody's fault but ours. */
export class BookingFlowFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingFlowFault';
  }
}

/**
 * The business code a downstream service put in an RpcException's `details`.
 * Catalog, identity and inventory all answer in this shape.
 */
export function refusalOf(
  error: unknown,
): { code: ErrorCode; details: ValidationIssueRef[] } | null {
  const payload =
    typeof (error as { getError?: unknown })?.getError === 'function'
      ? (error as { getError: () => unknown }).getError()
      : error;
  const raw =
    typeof payload === 'object' && payload !== null
      ? (payload as { details?: unknown }).details
      : undefined;
  if (typeof raw !== 'string' || raw.length === 0) return null;

  try {
    const parsed = JSON.parse(raw) as { code?: unknown; details?: unknown };
    if (!Object.values(ErrorCode).includes(parsed.code as ErrorCode)) {
      return null;
    }
    return {
      code: parsed.code as ErrorCode,
      details: Array.isArray(parsed.details)
        ? (parsed.details as ValidationIssueRef[])
        : [],
    };
  } catch {
    return null;
  }
}
