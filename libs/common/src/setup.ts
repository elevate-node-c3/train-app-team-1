import { INestApplication } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { ResponseInterceptor } from './envelope/response.interceptor.js';
import { HttpExceptionFilter } from './envelope/http-exception.filter.js';
import { ServiceRefusalFilter } from './errors/service-refusal.filter.js';
import { createValidationPipe } from './envelope/validation-exception.factory.js';

export interface SetupAppOptions {
  /**
   * Only the gateway sets a public prefix. Health probe paths stay unprefixed.
   */
  apiPrefix?: string;
  /**
   * Resolve a refusal into the caller's language. Only the edge can: the
   * Accept-Language header is not forwarded between services, so a service
   * that translated mid-call would answer everyone in Arabic.
   *
   * Every other service answers with the plain refusal instead, the same shape
   * it sends over gRPC.
   */
  localizesErrors?: boolean;
}

export function setupApp(
  app: INestApplication,
  options: SetupAppOptions = {},
): void {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(app.get(ResponseInterceptor));
  app.useGlobalFilters(
    options.localizesErrors
      ? app.get(HttpExceptionFilter)
      : app.get(ServiceRefusalFilter),
  );

  if (options.apiPrefix) {
    app.setGlobalPrefix(options.apiPrefix, {
      exclude: ['health', 'health/live', 'health/ready'],
    });
  }

  app.enableShutdownHooks();
}
