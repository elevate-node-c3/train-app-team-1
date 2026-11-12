import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR_CODE,
  type ValidationErrorDetail,
} from '@app/contracts';

/**
 * Catalog's refusal, restored from the gRPC error. A `code` is accepted only
 * if it names a known `ErrorCode`; malformed details are dropped, not forwarded.
 */

interface CatalogRefusal {
  code: ErrorCode;
  details: ValidationErrorDetail[];
  /** Present only on a `DEPENDENCY_UNAVAILABLE` refusal: how long to wait before retrying. */
  retryAfterSeconds?: number;
}

function isValidationDetail(value: unknown): value is ValidationErrorDetail {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.field === 'string' &&
    typeof candidate.issue === 'string' &&
    typeof candidate.action === 'string'
  );
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
      ? record.details.filter(isValidationDetail)
      : [],
    ...(typeof record.retryAfterSeconds === 'number'
      ? { retryAfterSeconds: record.retryAfterSeconds }
      : {}),
  };
}

/**
 * The HTTP exception a catalog refusal becomes, or null to let the transport
 * status decide. Fields go under `message`, which `HttpExceptionFilter` reads;
 * a `details` key would be silently dropped.
 */
export function parseCatalogBusinessError(
  error: unknown,
): HttpException | null {
  const refusal = decodeCatalogRefusal((error as { details?: unknown })?.details);
  if (!refusal) return null;

  return new HttpException(
    {
      code: refusal.code,
      message: refusal.details,
      // Forwarded onto the envelope; absent here stays absent there.
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: refusal.retryAfterSeconds }),
    },
    HTTP_STATUS_BY_ERROR_CODE[refusal.code] ??
      HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
