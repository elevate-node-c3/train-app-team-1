import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { ErrorCode } from '@app/contracts';

import { isCatalogSearchError } from './catalog-search-error.js';

/**
 * Mirrors `timetable-publish.service.ts`'s own `DEPENDENCY_RETRY_AFTER_SECONDS`
 * (the wait its refusal's `action` text names in prose). `CatalogSearchError`
 * has no field for it, so the envelope's `retryAfterSeconds` has nowhere else
 * to come from -- the transport is the one place left to close that gap
 * (task-8/9 reports' handoff).
 */
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/**
 * A generic client's categorisation only -- the gateway restores the real
 * business code from `details` and never trusts this number for anything
 * beyond a coarse status. Codes not listed fall back to INVALID_ARGUMENT,
 * which was every code this mapper had to handle before TA-20.
 */
const GRPC_STATUS_BY_ERROR_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.VALIDATION_ERROR]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.RESOURCE_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.CONFLICT]: grpc.status.ABORTED,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: grpc.status.UNAVAILABLE,
};

/**
 * Turns a refusal into a gRPC status. Shared by every catalog gRPC
 * controller -- do not copy this, import it; a second near-duplicate error
 * mapper is exactly the drift this story has already been bitten by.
 *
 * The business code travels in `details`, as identity's controller does it:
 * the status only tells a generic client how to categorise the failure, and
 * the gateway restores the code after validating it against the enum, so an
 * unknown string can never reach a traveller.
 *
 * The refusal carries only the code and the fields. The date strip and window
 * went with it for a while, so a client could re-render the picker beside the
 * error, but `ApiErrorDetail` has nowhere to put them and nothing at the edge
 * consumed them -- so they are not sent rather than sent and discarded.
 */
export function toRpcException(error: unknown): unknown {
  if (!isCatalogSearchError(error)) return error;

  return new RpcException({
    code: GRPC_STATUS_BY_ERROR_CODE[error.code] ?? grpc.status.INVALID_ARGUMENT,
    details: JSON.stringify({
      code: error.code,
      details: error.details,
      ...(error.code === ErrorCode.DEPENDENCY_UNAVAILABLE
        ? { retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS }
        : {}),
    }),
    message: error.message,
  });
}
