import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ClsModule, ClsService } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { createPinoConfig } from './logging/pino-config.js';
import { CorrelationMiddleware } from './correlation/correlation.middleware.js';
import { ResponseInterceptor } from './envelope/response.interceptor.js';
import { HttpExceptionFilter } from './envelope/http-exception.filter.js';
import { HealthModule } from './health/health.module.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({
  imports: [
    // Global, so the single DataSourceInitializer is resolvable from a feature
    // module without that module importing persistence plumbing.
    PersistenceModule,
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
    }),
    LoggerModule.forRootAsync({
      imports: [ClsModule],
      inject: [ClsService],
      useFactory: (cls: ClsService) => createPinoConfig(cls),
    }),
    HealthModule,
  ],
  providers: [CorrelationMiddleware, ResponseInterceptor, HttpExceptionFilter],
  exports: [
    PersistenceModule,
    ClsModule,
    LoggerModule,
    HealthModule,
    CorrelationMiddleware,
    ResponseInterceptor,
    HttpExceptionFilter,
  ],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
