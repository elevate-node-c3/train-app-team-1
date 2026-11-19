import { RpcException } from '@nestjs/microservices';
import { ErrorCode, grpcStatusForErrorCode } from '@app/contracts';

import {
  isRefusalError,
  type ServiceRefusal,
} from './service-refusal.js';

export interface RefusalTransportOptions {
  /**
   * A wait to advertise for codes whose delay is configuration rather than a
   * property of the error, as catalog's dependency backoff is.
   */
  retryAfterSeconds?: (code: ErrorCode) => number | undefined;
}

/** Build the envelope every service answers with and the gateway restores. */
export function refusalException(refusal: ServiceRefusal): RpcException {
  return new RpcException({
    code: grpcStatusForErrorCode(refusal.code),
    // The code is the whole message: text is the edge's job, in the caller's
    // language. Anything written here would reach one language's callers only.
    message: refusal.code,
    details: JSON.stringify({
      code: refusal.code,
      ...(refusal.details.length > 0 ? { details: refusal.details } : {}),
      ...(refusal.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: refusal.retryAfterSeconds }),
    }),
  });
}

/**
 * The one place a thrown error becomes a gRPC status, for every service.
 *
 * Anything that is not a refusal we decided becomes INTERNAL with no detail.
 * It is never rethrown as it arrived: a driver error's message can carry SQL,
 * national IDs and tokens, and gRPC would put it on the wire verbatim.
 */
export function toRpcException(
  error: unknown,
  options: RefusalTransportOptions = {},
): RpcException {
  if (error instanceof RpcException) return error;

  if (isRefusalError(error)) {
    return refusalException({
      code: error.code,
      details: error.details ?? [],
      retryAfterSeconds:
        error.retryAfterSeconds ?? options.retryAfterSeconds?.(error.code),
    });
  }

  return refusalException({
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    details: [],
  });
}
