import type { HttpException } from '@nestjs/common';
import {
  decodeRefusal,
  refusalHttpException,
  type ServiceRefusal,
} from '@app/common';

/** Decodes the refusal, or null when this is not one. */
export function decodeCatalogRefusal(details: unknown): ServiceRefusal | null {
  return decodeRefusal(details);
}

/**
 * Map a business refusal to HTTP; otherwise let the transport status decide.
 * The detail refs go under `message`, which HttpExceptionFilter resolves into
 * Arabic or English from the caller's Accept-Language.
 */
export function parseCatalogBusinessError(
  error: unknown,
): HttpException | null {
  const refusal = decodeRefusal((error as { details?: unknown })?.details);
  return refusal ? refusalHttpException(refusal) : null;
}
