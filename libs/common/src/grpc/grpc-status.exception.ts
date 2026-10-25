import { HttpException } from '@nestjs/common';
import { mapGrpcStatus } from '@app/contracts';

/**
 * Converts a gRPC status into the edge's HTTP exception without accepting the
 * upstream `details` string. That is the whole point: an internal message can
 * name a table, a stack frame or another account, so it never crosses into the
 * envelope (F5/G6).
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
