import type { ErrorCode, ValidationIssueRef } from '@app/contracts';

/**
 * A refused search.
 *
 * The service names the code and the fields; it deliberately knows nothing
 * about gRPC or HTTP, and the transport adapter turns this into a status.
 * Mirrors identity's `AuthError`, with `details` added because every search
 * refusal names the field to change and the change to make (BR-57).
 *
 * It carried the date strip and booking window for a while, so a client could
 * re-render the picker beside the error. That is a good idea with nowhere to
 * land: `ApiErrorDetail` has no room for them, and widening a shared envelope
 * for one feature is a bigger decision than this story should take alone. They
 * were removed rather than left travelling to a gateway that discarded them.
 */
export class CatalogSearchError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details: ValidationIssueRef[],
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
