import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { ResponseInterceptor } from './envelope/response.interceptor.js';
import { HttpExceptionFilter } from './envelope/http-exception.filter.js';

/**
 * Applies cross-cutting global filters, interceptors, validation pipes, and logging
 * across all seven services uniformly.
 */
export function setupApp(app: INestApplication): void {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(app.get(ResponseInterceptor));
  app.useGlobalFilters(app.get(HttpExceptionFilter));
  app.enableShutdownHooks();
}
