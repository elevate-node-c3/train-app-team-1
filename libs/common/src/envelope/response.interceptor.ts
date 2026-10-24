import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { ApiResponse, ErrorCode } from '@app/contracts';
import {
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
} from '../correlation/correlation.constants.js';
import { resolveLanguage, resolveMessage } from './catalogue.js';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  constructor(private readonly cls: ClsService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const acceptLanguage = req.headers['accept-language'];
    const lang = resolveLanguage(acceptLanguage);

    const correlationId =
      this.cls.get<string>(CORRELATION_ID_KEY) ||
      (req.headers[CORRELATION_ID_HEADER] as string) ||
      '';

    return next.handle().pipe(
      map((result: any) => {
        // If already structured with ApiResponse fields, pass through with guaranteed metadata
        if (
          result &&
          typeof result === 'object' &&
          'success' in result &&
          'data' in result
        ) {
          return {
            ...result,
            correlationId: result.correlationId || correlationId,
            timestamp: result.timestamp || new Date().toISOString(),
          };
        }

        let data = result;
        let message = resolveMessage(ErrorCode.SUCCESS, lang);

        if (result && typeof result === 'object' && result.__envelope) {
          data = result.data;
          message = result.message || message;
        }

        return {
          success: true,
          data,
          message,
          error: null,
          correlationId,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
