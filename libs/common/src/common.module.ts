import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ClsMiddleware, ClsModule, ClsService } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { createPinoConfig } from './logging/pino-config.js';
import { CorrelationMiddleware } from './correlation/correlation.middleware.js';
import { CallerMetadataMiddleware } from './caller/caller-metadata.middleware.js';
import { ResponseInterceptor } from './envelope/response.interceptor.js';
import { HttpExceptionFilter } from './envelope/http-exception.filter.js';
import { HealthModule } from './health/health.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';
import { RedisModule } from './cache/redis.module.js';

@Module({
  imports: [
    // Global so feature modules share one DataSourceInitializer.
    PersistenceModule,
    RedisModule,
    ClsModule.forRoot({
      global: true,
      // Mount CLS before correlation on every route, including health routes.
      middleware: { mount: false },
    }),
    LoggerModule.forRootAsync({
      imports: [ClsModule],
      inject: [ClsService],
      useFactory: (cls: ClsService) => createPinoConfig(cls),
    }),
    HealthModule,
  ],
  providers: [
    CorrelationMiddleware,
    CallerMetadataMiddleware,
    ResponseInterceptor,
    HttpExceptionFilter,
  ],
  exports: [
    PersistenceModule,
    RedisModule,
    ClsModule,
    LoggerModule,
    HealthModule,
    CorrelationMiddleware,
    CallerMetadataMiddleware,
    ResponseInterceptor,
    HttpExceptionFilter,
  ],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      // CLS must run first so caller and correlation middleware have a context.
      .apply(ClsMiddleware, CallerMetadataMiddleware, CorrelationMiddleware)
      .forRoutes('*');
  }
}
