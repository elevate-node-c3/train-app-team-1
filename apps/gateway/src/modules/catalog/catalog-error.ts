import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR_CODE,
  type BookingWindow,
  type DateStripDay,
  type ValidationErrorDetail,
} from '@app/contracts';

/**
 * Catalog's refusal, restored from the gRPC error.
 *
 * Deliberately a new function rather than a change to identity's: that one
 * reads only `code` and drops everything else, which is right for identity and
 * wrong here, because a search refusal's whole value is the field it names
 * (BR-57). It also belongs to another story's file.
 *
 * The trust rule is identity's, kept exactly: a `code` is accepted only if it
 * names a known `ErrorCode`, so an unrecognised string can never reach a
 * traveller. The same applies to the shapes -- a `details` entry that is not a
 * validation detail is dropped rather than forwarded.
 */

interface CatalogRefusal {
  code: ErrorCode;
  details: ValidationErrorDetail[];
  dateStrip?: DateStripDay[];
  bookingWindow?: BookingWindow;
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
    ...(typeof record.bookingWindow === 'object' && record.bookingWindow !== null
      ? { bookingWindow: record.bookingWindow as BookingWindow }
      : {}),
    ...(Array.isArray(record.dateStrip)
      ? { dateStrip: record.dateStrip as DateStripDay[] }
      : {}),
  };
}

/**
 * The HTTP exception a catalog refusal becomes, or null to let the transport
 * status decide.
 *
 * The fields travel under `message`, which is the channel `HttpExceptionFilter`
 * actually reads: `extractValidationDetails` walks `response.message` and
 * already understands objects carrying `field`, `issue` and `action`. Putting
 * them under a `details` key of our own invention looked right and was silently
 * dropped, so the traveller got a 400 naming nothing.
 *
 * The strip and window that travelled with the refusal stop here. `ApiErrorDetail`
 * has nowhere to put them, and widening a shared envelope for one feature is a
 * bigger decision than this story should take on its own -- so they are not
 * forwarded rather than being attached somewhere that quietly discards them.
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
    },
    HTTP_STATUS_BY_ERROR_CODE[refusal.code] ??
      HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
