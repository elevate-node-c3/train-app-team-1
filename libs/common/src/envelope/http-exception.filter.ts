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
import {
  ACTION_DEFAULT_KEY,
  DETAIL_CATALOGUE,
  ISSUE_FALLBACK_KEY,
  resolveDetailText,
} from './detail-catalogue.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  constructor(private readonly cls?: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
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

      // Trust only enum error codes, never arbitrary upstream detail strings.
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

      // Business refusals carry public refs; ordinary server errors stay log-only.
      if (
        status === HttpStatus.NOT_FOUND ||
        status === HttpStatus.CONFLICT ||
        (status === HttpStatus.SERVICE_UNAVAILABLE &&
          code === ErrorCode.DEPENDENCY_UNAVAILABLE)
      ) {
        details = this.extractValidationDetails(response, lang, false);
      }
    } else {
      // Unexpected errors return 500 without internal messages or stack traces.
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      code = ErrorCode.INTERNAL_SERVER_ERROR;
    }

    // Keep full error details in correlated logs, not client responses.
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
    allowBareMessages = true,
  ): ValidationErrorDetail[] | undefined {
    if (!response || typeof response !== 'object') {
      return undefined;
    }

    const resObj = response as Record<string, unknown>;
    const messages = resObj.message ?? resObj.details;

    if (!messages) {
      return undefined;
    }

    const defaultAction = resolveDetailText(ACTION_DEFAULT_KEY, lang);

    if (Array.isArray(messages)) {
      return messages.flatMap<ValidationErrorDetail>((msgItem) => {
        if (typeof msgItem === 'string') {
          if (!allowBareMessages) return [];
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
          if (
            typeof itemObj.field === 'string' &&
            typeof itemObj.issueKey === 'string'
          ) {
            const params =
              itemObj.params !== null &&
              typeof itemObj.params === 'object' &&
              !Array.isArray(itemObj.params) &&
              Object.values(itemObj.params).every(
                (value) => typeof value === 'string',
              )
                ? (itemObj.params as Record<string, string>)
                : undefined;
            const issue = resolveDetailText(itemObj.issueKey, lang, params);
            const actionKey =
              typeof itemObj.actionKey === 'string' &&
              Object.hasOwn(DETAIL_CATALOGUE, itemObj.actionKey)
                ? itemObj.actionKey
                : ACTION_DEFAULT_KEY;
            const action = resolveDetailText(actionKey, lang, params);
            return {
              field: itemObj.field,
              rejectedValue: itemObj.rejectedValue,
              // Version skew must not expose an unfilled template to a caller.
              issue: issue.includes('{{')
                ? resolveDetailText(ISSUE_FALLBACK_KEY, lang)
                : issue,
              action: action.includes('{{') ? defaultAction : action,
            };
          }
        }
        return [];
      });
    }

    if (allowBareMessages && typeof messages === 'string') {
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
