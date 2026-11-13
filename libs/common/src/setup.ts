import { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { ResponseInterceptor } from './envelope/response.interceptor.js';
import { HttpExceptionFilter } from './envelope/http-exception.filter.js';
import { createValidationPipe } from './envelope/validation-exception.factory.js';

export interface SetupAppOptions {
  /**
   * Only the gateway sets a public prefix. Health probe paths stay unprefixed.
   */
  apiPrefix?: string;
}

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
