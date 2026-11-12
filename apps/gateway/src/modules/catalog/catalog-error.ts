import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR_CODE,
  isValidationIssueRef,
  type ValidationIssueRef,
} from '@app/contracts';

/** Accept known ErrorCode values and drop malformed error details. */

interface CatalogRefusal {
  code: ErrorCode;
  details: ValidationIssueRef[];
  /** Present only on a `DEPENDENCY_UNAVAILABLE` refusal: how long to wait before retrying. */
  retryAfterSeconds?: number;
}

/** Decodes the refusal, or null when this is not one. */
export function decodeCatalogRefusal(details: unknown): CatalogRefusal | null {
  if (typeof details !== 'string' || details.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (
    typeof record.code !== 'string' ||
    !Object.values(ErrorCode).includes(record.code as ErrorCode)
  ) {
    return null;
  }

  return {
    code: record.code as ErrorCode,
    details: Array.isArray(record.details)
      ? record.details.filter(isValidationIssueRef)
      : [],
    ...(typeof record.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: record.retryAfterSeconds }
      : {}),
  };
}

/**
 * Map business refusals to HTTP; otherwise let transport status decide.
 * Put field details under message, which HttpExceptionFilter reads.
 */
export function parseCatalogBusinessError(
  error: unknown,
): HttpException | null {
  const refusal = decodeCatalogRefusal(
    (error as { details?: unknown })?.details,
  );
  if (!refusal) return null;

  return new HttpException(
    {
      code: refusal.code,
      message: refusal.details,
      // Preserve missing retry hints.
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: refusal.retryAfterSeconds }),
    },
    HTTP_STATUS_BY_ERROR_CODE[refusal.code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
