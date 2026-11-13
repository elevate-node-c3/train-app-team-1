import type { ErrorCode, ValidationIssueRef } from '@app/contracts';

/**
 * Transport-neutral code and actionable fields; adapters choose gRPC/HTTP status.
 * ApiErrorDetail cannot carry date strips or booking windows, so this error
 * does not include them.
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
