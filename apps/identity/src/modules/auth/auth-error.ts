import type { ErrorCode, ValidationErrorDetail } from '@app/contracts';

/**
 * A business failure the transport adapter turns into a status. The service
 * names the code; it deliberately knows nothing about gRPC or HTTP.
 * `retryAfterSeconds` is a hint for the edge's envelope.
 * `details` carries field-level validation errors (BR-57).
 */
export class AuthError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly retryAfterSeconds?: number,
    readonly details: ValidationErrorDetail[] = [],
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
