import type { ErrorCode } from '@app/contracts';

/**
 * A business failure the presentation layer turns into a transport status.
 * The application layer names the code; it deliberately knows nothing about
 * gRPC or HTTP. `retryAfterSeconds` is a hint for the edge's envelope.
 */
export class AuthError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
