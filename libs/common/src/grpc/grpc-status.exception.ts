import { HttpException } from '@nestjs/common';
import { mapGrpcStatus } from '@app/contracts';

/**
 * Maps gRPC status to HTTP without forwarding upstream `details`, which may
 * expose database, stack or account information.
 */
export function grpcStatusException(code: number): HttpException {
  const mapping = mapGrpcStatus(code);
  return new HttpException(
    {
      code: mapping.errorCode,
      ...(mapping.retryAfterSeconds
        ? { retryAfterSeconds: mapping.retryAfterSeconds }
        : {}),
    },
    mapping.httpStatus,
  );
}
