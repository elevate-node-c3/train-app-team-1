import { ErrorCode } from './error-codes.enum.js';

/**
 * Numeric gRPC status values, duplicated as a const enum-like object rather
 * than imported from `@grpc/grpc-js`: contracts is pure shapes by charter, and
 * the values are part of the gRPC wire protocol, not an implementation detail
 * of one client library.
 */
export const GRPC_STATUS = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const;

export type GrpcStatusCode = (typeof GRPC_STATUS)[keyof typeof GRPC_STATUS];

export interface GrpcHttpMapping {
  httpStatus: number;
  errorCode: ErrorCode;
  /** True when retrying the same call can plausibly succeed. */
  retryable: boolean;
  /** A hint the edge may expose in the envelope. */
  retryAfterSeconds?: number;
}

/**
 * The one place a gRPC status becomes an HTTP answer (F5/G6).
 *
 * PERMISSION_DENIED deliberately maps to 404, not 403: BR-09 says "not yours"
 * and "does not exist" must be indistinguishable.
 */
export const GRPC_HTTP_MAP: Readonly<Record<number, GrpcHttpMapping>> = {
  [GRPC_STATUS.OK]: {
    httpStatus: 200,
    errorCode: ErrorCode.SUCCESS,
    retryable: false,
  },
  [GRPC_STATUS.CANCELLED]: {
    httpStatus: 503,
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    retryable: true,
    retryAfterSeconds: 1,
  },
  [GRPC_STATUS.UNKNOWN]: {
    httpStatus: 500,
    errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
    retryable: false,
  },
  [GRPC_STATUS.INVALID_ARGUMENT]: {
    httpStatus: 400,
    errorCode: ErrorCode.BAD_REQUEST,
    retryable: false,
  },
  [GRPC_STATUS.DEADLINE_EXCEEDED]: {
    httpStatus: 504,
    errorCode: ErrorCode.GATEWAY_TIMEOUT,
    retryable: true,
    retryAfterSeconds: 1,
  },
  [GRPC_STATUS.NOT_FOUND]: {
    httpStatus: 404,
    errorCode: ErrorCode.RESOURCE_NOT_FOUND,
    retryable: false,
  },
  [GRPC_STATUS.ALREADY_EXISTS]: {
    httpStatus: 409,
    errorCode: ErrorCode.CONFLICT,
    retryable: false,
  },
  [GRPC_STATUS.PERMISSION_DENIED]: {
    // BR-09: the same answer as NOT_FOUND.
    httpStatus: 404,
    errorCode: ErrorCode.RESOURCE_NOT_FOUND,
    retryable: false,
  },
  [GRPC_STATUS.RESOURCE_EXHAUSTED]: {
    httpStatus: 429,
    errorCode: ErrorCode.RATE_LIMITED,
    retryable: true,
    retryAfterSeconds: 60,
  },
  [GRPC_STATUS.FAILED_PRECONDITION]: {
    httpStatus: 409,
    errorCode: ErrorCode.CONFLICT,
    retryable: false,
  },
  [GRPC_STATUS.ABORTED]: {
    httpStatus: 409,
    errorCode: ErrorCode.CONFLICT,
    retryable: true,
    retryAfterSeconds: 1,
  },
  [GRPC_STATUS.OUT_OF_RANGE]: {
    httpStatus: 400,
    errorCode: ErrorCode.BAD_REQUEST,
    retryable: false,
  },
  [GRPC_STATUS.UNIMPLEMENTED]: {
    httpStatus: 501,
    errorCode: ErrorCode.NOT_IMPLEMENTED,
    retryable: false,
  },
  [GRPC_STATUS.INTERNAL]: {
    httpStatus: 500,
    errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
    retryable: false,
  },
  [GRPC_STATUS.UNAVAILABLE]: {
    httpStatus: 503,
    errorCode: ErrorCode.SERVICE_UNAVAILABLE,
    retryable: true,
    retryAfterSeconds: 1,
  },
  [GRPC_STATUS.DATA_LOSS]: {
    httpStatus: 500,
    errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
    retryable: false,
  },
  [GRPC_STATUS.UNAUTHENTICATED]: {
    httpStatus: 401,
    errorCode: ErrorCode.UNAUTHORIZED,
    retryable: false,
  },
};

/**
 * Total, including unknown numeric statuses: an unrecognised code must never
 * become a success. Returns INTERNAL for values outside the protocol.
 */
export function mapGrpcStatus(code: number): GrpcHttpMapping {
  return (
    GRPC_HTTP_MAP[code] ?? {
      httpStatus: 500,
      errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
      retryable: false,
    }
  );
}
