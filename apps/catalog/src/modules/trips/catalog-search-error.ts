import type { ErrorCode, ValidationErrorDetail } from '@app/contracts';

/**
 * A refused search. The service names the code and the fields; it deliberately
 * knows nothing about gRPC or HTTP, and the transport adapter turns this into a
 * status. Mirrors identity's `AuthError`, with `details` added because every
 * search refusal names the field to change (BR-57).
 */
export class CatalogSearchError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details: ValidationErrorDetail[] = [],
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
