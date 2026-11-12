import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { ErrorCode } from '@app/contracts';

import { dependencyRetryAfterSeconds } from '../../config/operations-settings.js';
import { isCatalogSearchError } from './catalog-search-error.js';

/** Coarse status only; the gateway restores the business code from `details`. */
const GRPC_STATUS_BY_ERROR_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.VALIDATION_ERROR]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.RESOURCE_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.CONFLICT]: grpc.status.ABORTED,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: grpc.status.UNAVAILABLE,
};

/**
 * Business code and dependency retry delays belong in transport details.
 * Share this mapping across controllers.
 */
export function toRpcException(error: unknown): unknown {
  if (!isCatalogSearchError(error)) return error;

  return new RpcException({
    code: GRPC_STATUS_BY_ERROR_CODE[error.code] ?? grpc.status.INVALID_ARGUMENT,
    details: JSON.stringify({
      code: error.code,
      details: error.details,
      ...(error.code === ErrorCode.DEPENDENCY_UNAVAILABLE
        ? { retryAfterSeconds: dependencyRetryAfterSeconds() }
        : {}),
    }),
    message: error.message,
  });
}
