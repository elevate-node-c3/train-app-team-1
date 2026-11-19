import { ErrorCode } from '@app/contracts';
import { toRpcException as toSharedRpcException } from '@app/common';

import { dependencyRetryAfterSeconds } from '../../config/operations-settings.js';

/**
 * Catalog's gRPC boundary. The envelope, the status and the masking of
 * anything we did not decide are all @app/common's; the only thing catalog
 * adds is how long a caller should wait for a dependency to come back.
 */
export function toRpcException(error: unknown): unknown {
  return toSharedRpcException(error, {
    retryAfterSeconds: (code) =>
      code === ErrorCode.DEPENDENCY_UNAVAILABLE
        ? dependencyRetryAfterSeconds()
        : undefined,
  });
}
