import type { ErrorCode, ValidationIssueRef } from '@app/contracts';

/**
 * A business failure the transport adapter turns into a status. The service
 * names the code; it deliberately knows nothing about gRPC or HTTP.
 * `retryAfterSeconds` is a hint for the edge's envelope.
 * `details` carries field-level validation errors as language-free keys the
 * gateway resolves into the caller's language (BR-57).
 */
export class AuthError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly retryAfterSeconds?: number,
    readonly details: ValidationIssueRef[] = [],
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
