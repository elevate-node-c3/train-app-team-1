import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ErrorCode, isValidationIssueRef } from '@app/contracts';

import { CORRELATION_ID_KEY } from '../correlation/correlation.constants.js';
import { isErrorCode, type ServiceRefusal } from './service-refusal.js';

/**
 * How a service that is not the edge answers an HTTP request: with the plain
 * refusal, exactly as it answers over gRPC.
 *
 * No text. Resolving a code into Arabic or English needs the caller's
 * Accept-Language, and that header is not forwarded between services, so a
 * service translating here would answer every caller in Arabic. The gateway
 * holds the language and does the resolving -- HttpExceptionFilter is its job
 * alone.
 *
 * These services serve health probes and their service-info route; a refusal
 * here is for an operator or the gateway, never a traveller.
 */
@Catch()
export class ServiceRefusalFilter implements ExceptionFilter {
  private readonly logger = new Logger(ServiceRefusalFilter.name);

  constructor(private readonly cls?: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = this.cls?.get<string>(CORRELATION_ID_KEY) ?? '';

    // The cause stays in the correlated log; the body carries none of it.
    this.logger.error(
      `[${correlationId}] ${
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception)
      }`,
    );

    const { status, refusal } = refusalOf(exception);
    response.status(status).json(refusal);
  }
}

function refusalOf(exception: unknown): {
  status: number;
  refusal: ServiceRefusal;
} {
  if (!(exception instanceof HttpException)) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      refusal: { code: ErrorCode.INTERNAL_SERVER_ERROR, details: [] },
    };
  }

  const status = exception.getStatus();
  const body = exception.getResponse();
  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};

  const retryAfterSeconds = record.retryAfterSeconds;
  return {
    status,
    refusal: {
      code: isErrorCode(record.code) ? record.code : codeForStatus(status),
      // The refs travel as they were written; only the edge resolves them.
      details: [record.details, record.message]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter(isValidationIssueRef),
      ...(typeof retryAfterSeconds === 'number' &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
        ? { retryAfterSeconds: Math.ceil(retryAfterSeconds) }
        : {}),
    },
  };
}

/** Only for a Nest-raised exception that named no code of ours. */
function codeForStatus(status: number): ErrorCode {
  if (status === HttpStatus.NOT_FOUND) return ErrorCode.ROUTE_NOT_FOUND;
  if (status === HttpStatus.UNAUTHORIZED) return ErrorCode.UNAUTHORIZED;
  if (status === HttpStatus.FORBIDDEN) return ErrorCode.FORBIDDEN;
  if (status === HttpStatus.SERVICE_UNAVAILABLE) {
    return ErrorCode.SERVICE_UNAVAILABLE;
  }
  return status >= HttpStatus.INTERNAL_SERVER_ERROR
    ? ErrorCode.INTERNAL_SERVER_ERROR
    : ErrorCode.BAD_REQUEST;
}
