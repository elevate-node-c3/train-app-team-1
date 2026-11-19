import { HttpException, HttpStatus } from '@nestjs/common';
import { HTTP_STATUS_BY_ERROR_CODE } from '@app/contracts';

import { decodeRefusal } from './decode-refusal.js';
import type { ServiceRefusal } from './service-refusal.js';

/**
 * A refusal as HTTP. The detail refs go under `message`, where
 * HttpExceptionFilter reads them and resolves each key into the caller's
 * language; the code becomes the localized message the same way. No text from
 * the service is carried across.
 */
export function refusalHttpException(refusal: ServiceRefusal): HttpException {
  return new HttpException(
    {
      code: refusal.code,
      // `message` is the key HttpExceptionFilter reads the refs from; a
      // refusal with nothing field-level to say carries none.
      ...(refusal.details.length > 0 ? { message: refusal.details } : {}),
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: refusal.retryAfterSeconds }),
    },
    HTTP_STATUS_BY_ERROR_CODE[refusal.code] ??
      HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/**
 * Turn a failed downstream call into HTTP when it carried a refusal, or null
 * when only its transport status can answer -- grpcStatusException's case.
 */
export function refusalHttpExceptionFrom(error: unknown): HttpException | null {
  const refusal = decodeRefusal(error);
  return refusal ? refusalHttpException(refusal) : null;
}
