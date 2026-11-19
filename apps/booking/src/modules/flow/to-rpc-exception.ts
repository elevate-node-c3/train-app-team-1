import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { ErrorCode } from '@app/contracts';

import { BookingFlowFault, isBookingFlowError } from './booking-flow-error.js';

/** Coarse status only; the gateway restores the business code from `details`. */
const GRPC_STATUS_BY_ERROR_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.VALIDATION_ERROR]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.PASSENGERS_REQUIRED]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.TOO_MANY_PASSENGERS]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.DUPLICATE_PASSENGER]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.INVALID_PAYLOAD]: grpc.status.INVALID_ARGUMENT,
  [ErrorCode.PASSENGER_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.RESOURCE_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.HOLD_NOT_FOUND]: grpc.status.NOT_FOUND,
  [ErrorCode.PASSENGER_ALREADY_BOOKED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.TERMS_REQUIRED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.INSUFFICIENT_SEATS]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.SALES_CLOSED]: grpc.status.FAILED_PRECONDITION,
  [ErrorCode.SEAT_ALREADY_TAKEN]: grpc.status.ABORTED,
  [ErrorCode.SEAT_TAKEN]: grpc.status.ABORTED,
  [ErrorCode.CONFLICT]: grpc.status.ABORTED,
  [ErrorCode.BOOKING_KEY_CONFLICT]: grpc.status.ALREADY_EXISTS,
  [ErrorCode.UNAUTHORIZED]: grpc.status.UNAUTHENTICATED,
  [ErrorCode.FORBIDDEN]: grpc.status.PERMISSION_DENIED,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: grpc.status.UNAVAILABLE,
};

/**
 * The one place the flow's errors become transport. A fault says nothing about
 * its cause: SQL messages and identity values must not reach a client.
 */
export function toRpcException(error: unknown): unknown {
  if (error instanceof RpcException) return error;

  if (isBookingFlowError(error)) {
    return new RpcException({
      code: GRPC_STATUS_BY_ERROR_CODE[error.code] ?? grpc.status.INTERNAL,
      details: JSON.stringify({ code: error.code, details: error.details }),
      message: error.code,
    });
  }

  if (error instanceof BookingFlowFault) {
    return new RpcException({
      code: grpc.status.INTERNAL,
      details: JSON.stringify({ code: ErrorCode.INTERNAL_SERVER_ERROR }),
      message: 'The booking could not be completed.',
    });
  }

  return error;
}

export function grpcStatusFor(code: ErrorCode): number {
  return GRPC_STATUS_BY_ERROR_CODE[code] ?? grpc.status.INTERNAL;
}
