import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { MessagingModule } from '@app/messaging';
import { ServiceInfoController } from './service-info.controller.js';
import { TripLifecycleModule } from './modules/trip-lifecycle/trip-lifecycle.module.js';
import { SeatUsageModule } from './modules/seat-usage/seat-usage.module.js';

/**
 * Root module: infrastructure wiring and feature modules only. Business
 * providers belong to the feature module that owns them.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    MessagingModule,
    TripLifecycleModule,
    SeatUsageModule,
  ],
  controllers: [ServiceInfoController],
})
export class InventoryModule {}
