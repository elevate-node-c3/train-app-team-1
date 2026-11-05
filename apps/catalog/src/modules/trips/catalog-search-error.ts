import type {
  BookingWindow,
  DateStripDay,
  ErrorCode,
  ValidationErrorDetail,
} from '@app/contracts';

/**
 * A refused search.
 *
 * The service names the code and the fields; it deliberately knows nothing
 * about gRPC or HTTP, and the transport adapter turns this into a status.
 * Mirrors identity's `AuthError`, with two additions.
 *
 * `details` carries the fields, because every search refusal names what to
 * change (BR-57).
 *
 * The date strip and window travel with the refusal so a client can keep
 * rendering the picker beside the error. A traveller who picked an impossible
 * date needs to see which dates are possible in the same response -- being
 * told "that date is wrong" and then having nothing to choose from is the
 * failure this is avoiding.
 */
export class CatalogSearchError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details: ValidationErrorDetail[],
    readonly dateStrip: DateStripDay[],
    readonly bookingWindow: BookingWindow,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CatalogSearchError';
  }
}

export function isCatalogSearchError(
  error: unknown,
): error is CatalogSearchError {
  return error instanceof CatalogSearchError;
}
