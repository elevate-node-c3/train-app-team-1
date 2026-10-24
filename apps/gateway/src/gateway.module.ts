import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { MessagingModule } from '@app/messaging';
import { HealthAggregationModule } from './modules/health-aggregation/health-aggregation.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { ServiceInfoController } from './service-info.controller.js';

/**
 * Root module: infrastructure wiring and feature modules only. Business
 * providers belong to the feature module that owns them.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    MessagingModule,
    HealthAggregationModule,
    AccountsModule,
  ],
  controllers: [ServiceInfoController],
})
export class GatewayModule {}
