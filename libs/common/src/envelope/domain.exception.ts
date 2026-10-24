import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@app/contracts';

/**
 * Client-safe metadata a domain error may expose, e.g. `retryAfterSeconds`.
 * Values must never include secrets, codes, or whether an account exists.
 */
export type DomainErrorMeta = Record<string, string | number | boolean>;

/**
 * An HttpException that carries its own error code and safe metadata, which
 * HttpExceptionFilter passes through instead of deriving a code from the status.
 * The exception message is the code itself so that the logged stack trace
 * never contains request data.
 */
export class DomainException extends HttpException {
  constructor(
    readonly code: ErrorCode | string,
    status: HttpStatus,
    readonly meta?: DomainErrorMeta,
  ) {
    super(code, status);
    this.name = 'DomainException';
  }

  /** @returns the whole seconds to wait before retrying, or undefined if none */
  get retryAfterSeconds(): number | undefined {
    const value = this.meta?.retryAfterSeconds;
    return typeof value === 'number' && value >= 0
      ? Math.ceil(value)
      : undefined;
  }
}
