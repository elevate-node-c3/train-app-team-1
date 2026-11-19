import type { RpcException } from '@nestjs/microservices';
import { toRpcException as toSharedRpcException } from '@app/common';

/**
 * The flow's gRPC boundary. BookingFlowError carries the code, so the shared
 * helper answers it; a BookingFlowFault carries none and is masked, which is
 * what we want -- a fault says nothing about its cause.
 */
export function toRpcException(error: unknown): RpcException {
  return toSharedRpcException(error);
}
