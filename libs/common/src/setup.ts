import { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { ResponseInterceptor } from './envelope/response.interceptor.js';
import { HttpExceptionFilter } from './envelope/http-exception.filter.js';
import { createValidationPipe } from './envelope/validation-exception.factory.js';

export interface SetupAppOptions {
  /**
   * The public HTTP prefix for this process. Only the gateway sets one: it is
   * the single door, so `/api/v1` exists there and nowhere else. Health routes
   * stay unprefixed because orchestrators probe them by their stable path.
   */
  apiPrefix?: string;
}

/**
 * Applies cross-cutting global filters, interceptors, validation pipes, and logging
 * across all seven services uniformly.
 */
export function setupApp(
  app: INestApplication,
  options: SetupAppOptions = {},
): void {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(app.get(ResponseInterceptor));
  app.useGlobalFilters(app.get(HttpExceptionFilter));

  if (options.apiPrefix) {
    app.setGlobalPrefix(options.apiPrefix, {
      exclude: ['health', 'health/live', 'health/ready'],
    });
  }

  app.enableShutdownHooks();
}
