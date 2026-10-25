import { ErrorCode } from './error-codes.enum.js';

/**
 * The HTTP answer a business code deserves at the edge. This is a contract
 * fact, not a transport-adapter detail, so it sits beside `GRPC_HTTP_MAP` and
 * the two tables can be tested against each other.
 */
export const HTTP_STATUS_BY_ERROR_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.RESOURCE_NOT_FOUND]: 404,
  [ErrorCode.EMAIL_ALREADY_REGISTERED]: 409,
  [ErrorCode.EMAIL_NOT_VERIFIED]: 409,
  [ErrorCode.VERIFICATION_REQUIRED]: 409,
  [ErrorCode.INVALID_VERIFICATION_CODE]: 400,
  [ErrorCode.VERIFICATION_CODE_EXPIRED]: 400,
  [ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED]: 429,
  [ErrorCode.RESEND_TOO_SOON]: 429,
  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.ACCOUNT_LOCKED]: 429,
  [ErrorCode.ACCOUNT_DISABLED]: 403,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.TOKEN_INVALID]: 401,
  [ErrorCode.TOKEN_REVOKED]: 401,
  [ErrorCode.INVALID_REFRESH_TOKEN]: 401,
  [ErrorCode.REFRESH_TOKEN_REUSE_DETECTED]: 401,
  [ErrorCode.SESSION_REVOKED]: 401,
  [ErrorCode.PASSWORD_REUSE]: 400,
  [ErrorCode.PASSWORD_RESET_INVALID]: 400,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.PROFILE_INCOMPLETE]: 403,
};
