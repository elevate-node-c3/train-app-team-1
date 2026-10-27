import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { migrations } from './database/migrations/index.js';
import { SecurityModule } from './common/security/security.module.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
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
    MigrationModule,
    HealthModule,
    SecurityModule,
    IdentityModule,
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
