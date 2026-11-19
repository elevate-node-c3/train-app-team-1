import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

/**
 * What a service decided to refuse, and the only thing that crosses a
 * transport. There is no text here on purpose: the code and the detail keys
 * are resolved into Arabic or English at the edge, from the caller's
 * Accept-Language. A service that wrote a sentence instead would answer every
 * caller in one language (BR-57).
 */
export interface ServiceRefusal {
  code: ErrorCode;
  details: ValidationIssueRef[];
  /** Only on a retryable refusal: how long the caller should wait. */
  retryAfterSeconds?: number;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    Object.values(ErrorCode).includes(value as ErrorCode)
  );
}

/**
 * A refusal our own code raised. Each service keeps its own class and its own
 * extra fields -- AuthError, HoldCoreError, CatalogSearchError and the rest --
 * and they all answer to this shape.
 */
export type RefusalError = Error & {
  readonly code: ErrorCode;
  readonly details?: ValidationIssueRef[];
  readonly retryAfterSeconds?: number;
};

/**
 * The code must be one of ours, so an error that merely happens to carry a
 * `code` is not mistaken for a decision: a Postgres error says '23505' and a
 * filesystem error says 'ENOENT', and neither is a refusal to report.
 */
export function isRefusalError(error: unknown): error is RefusalError {
  return (
    error instanceof Error &&
    isErrorCode((error as { code?: unknown }).code)
  );
}
