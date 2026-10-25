import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { ApiResponse, ErrorCode, ValidationErrorDetail } from '@app/contracts';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from '../correlation/correlation.constants.js';
import {
  resolveLanguage,
  resolveMessage,
  SupportedLanguage,
} from './catalogue.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly cls?: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // In non-HTTP contexts (e.g. gRPC or microservices), rethrow or let Nest handle it
      throw exception;
    }

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const acceptLanguage = req.headers['accept-language'];
    const lang: SupportedLanguage = resolveLanguage(acceptLanguage);

    const correlationId =
      this.cls?.get<string>(CORRELATION_ID_KEY) ||
      (req.headers[CORRELATION_ID_HEADER] as string) ||
      '';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCode.INTERNAL_SERVER_ERROR;
    let details: ValidationErrorDetail[] | undefined;
    let retryAfterSeconds: number | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();

      // An adapter that knows *why* it failed can send a stable code. It is
      // only trusted when it names a code in the enum, so a gRPC detail string
      // can never become a client-visible code.
      if (response && typeof response === 'object') {
        const explicit = (response as Record<string, unknown>).code;
        if (
          typeof explicit === 'string' &&
          Object.values(ErrorCode).includes(explicit as ErrorCode)
        ) {
          code = explicit;
        }
        const retry = (response as Record<string, unknown>).retryAfterSeconds;
        if (typeof retry === 'number' && Number.isFinite(retry) && retry > 0) {
          retryAfterSeconds = Math.ceil(retry);
        }
      }

      switch (status) {
        case HttpStatus.BAD_REQUEST:
          if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
            code = ErrorCode.BAD_REQUEST;
          }
          // Extract class-validator errors
          details = this.extractValidationDetails(response, lang);
          if (details && details.length > 0) {
            code = ErrorCode.VALIDATION_ERROR;
          }
          break;
        case HttpStatus.NOT_FOUND:
          if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
            code = ErrorCode.ROUTE_NOT_FOUND;
          }
          break;
        case HttpStatus.UNAUTHORIZED:
          if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
            code = ErrorCode.UNAUTHORIZED;
          }
          break;
        case HttpStatus.FORBIDDEN:
          if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
            code = ErrorCode.FORBIDDEN;
          }
          break;
        case HttpStatus.SERVICE_UNAVAILABLE:
          if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
            code = ErrorCode.SERVICE_UNAVAILABLE;
          }
          break;
        default:
          if (status >= 500) {
            if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
              code = ErrorCode.INTERNAL_SERVER_ERROR;
            }
          } else if (code === ErrorCode.INTERNAL_SERVER_ERROR) {
            code = ErrorCode.BAD_REQUEST;
          }
          break;
      }
    } else {
      // Non-HttpException: Always 500, never leak stack trace or internal message to client
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCode.INTERNAL_SERVER_ERROR;
    }

    // Full detail goes to the service log with the correlation ID (§2.4)
    this.logger.error(
      `[${correlationId}] Handled exception: ${exception instanceof Error ? exception.stack : String(exception)}`,
    );

    const localizedMessage = resolveMessage(code, lang);

    const errorEnvelope: ApiResponse<null> = {
      success: false,
      data: null,
      message: localizedMessage,
      error: {
        code,
        message: localizedMessage,
        ...(details && details.length > 0 ? { details } : {}),
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      },
      correlationId,
      timestamp: new Date().toISOString(),
    };

    res.status(status).json(errorEnvelope);
  }

  private extractValidationDetails(
    response: unknown,
    lang: SupportedLanguage,
  ): ValidationErrorDetail[] | undefined {
    if (!response || typeof response !== 'object') {
      return undefined;
    }

    const resObj = response as Record<string, unknown>;
    const messages = resObj.message;

    if (!messages) {
      return undefined;
    }

    const defaultAction =
      lang === 'en'
        ? 'Please provide a valid value according to the specified constraints and try again'
        : 'يرجى تقديم قيمة صالحة وفقاً للشروط المحددة والمحاولة مرة أخرى';

    // If message is an array of strings produced by ValidationPipe
    if (Array.isArray(messages)) {
      return messages.map((msgItem) => {
        if (typeof msgItem === 'string') {
          // Attempt to extract property name from validation string (e.g. "email must be an email")
          const firstWord = msgItem.split(' ')[0] || 'field';
          return {
            field: firstWord,
            rejectedValue: undefined,
            issue: msgItem,
            action: defaultAction,
          };
        }
        if (typeof msgItem === 'object' && msgItem !== null) {
          const itemObj = msgItem as Record<string, unknown>;
          const field =
            typeof itemObj.property === 'string'
              ? itemObj.property
              : typeof itemObj.field === 'string'
                ? itemObj.field
                : 'field';
          const issue =
            typeof itemObj.constraints === 'object' &&
            itemObj.constraints !== null
              ? Object.values(
                  itemObj.constraints as Record<string, string>,
                ).join(', ')
              : typeof itemObj.issue === 'string'
                ? itemObj.issue
                : typeof itemObj.message === 'string'
                  ? itemObj.message
                  : 'Validation failed';
          const action =
            typeof itemObj.action === 'string' && itemObj.action.length > 0
              ? itemObj.action
              : defaultAction;
          return {
            field,
            rejectedValue:
              'rejectedValue' in itemObj
                ? itemObj.rejectedValue
                : itemObj.value,
            issue,
            action,
          };
        }
        return {
          field: 'field',
          rejectedValue: undefined,
          issue: String(msgItem),
          action: defaultAction,
        };
      });
    }

    if (typeof messages === 'string') {
      return [
        {
          field: 'payload',
          rejectedValue: undefined,
          issue: messages,
          action: defaultAction,
        },
      ];
    }

    return undefined;
  }
}
