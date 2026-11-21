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
import { CardDataSanitizationGuard } from './common/guards/card-data-sanitization.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { BookingModule } from './modules/booking/booking.module.js';
import { SavedCardsModule } from './modules/saved-cards/saved-cards.module.js';
import { ServiceInfoController } from './service-info.controller.js';

/** Wires infrastructure; feature modules own business providers. */
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
    CatalogModule,
    OperationsModule,
    BookingModule,
    SavedCardsModule,
  ],
  controllers: [ServiceInfoController],
  providers: [
    // Rate limiting runs before costly signature verification.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Deny-by-default: every route must declare `@Public()` or an access level.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CardDataSanitizationGuard },
  ],
})
export class GatewayModule {}
