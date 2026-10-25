import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { MessagingModule } from '@app/messaging';
import { migrations } from './database/migrations/index.js';
import { HealthAggregationModule } from './modules/health-aggregation/health-aggregation.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { JwtAuthGuard } from './modules/auth/presentation/http/guards/jwt-auth.guard.js';
import { RateLimitGuard } from './modules/auth/presentation/http/guards/rate-limit.guard.js';
import { ServiceInfoController } from './service-info.controller.js';

/**
 * Root module: infrastructure wiring and feature modules only. Business
 * providers belong to the feature module that owns them.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    MigrationModule,
    HealthAggregationModule,
    AccountsModule,
    AuthModule,
  ],
  controllers: [ServiceInfoController],
  providers: [
    // Rate limiting runs first so an unauthenticated flood is cut before any
    // signature verification work.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Deny-by-default: every route must declare `@Public()` or an access level.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class GatewayModule {}
