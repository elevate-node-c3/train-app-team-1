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
    // Global, so the single DataSourceInitializer is resolvable from a feature
    // module without that module importing persistence plumbing.
    PersistenceModule,
    RedisModule,
    ClsModule.forRoot({
      global: true,
      // Mounted explicitly in `configure` below. The automatic mount point is
      // derived from the Express version and the gateway's global prefix, which
      // left correlation running before the store existed on excluded routes
      // such as /health/live. One ordered chain is simpler and correct.
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
      // ClsMiddleware must be first: it owns the AsyncLocalStorage context that
      // the next two middlewares write into.
      .apply(ClsMiddleware, CallerMetadataMiddleware, CorrelationMiddleware)
      .forRoutes('*');
  }
}
