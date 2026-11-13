import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { MessagingModule, OutboxModule } from '@app/messaging';
import { migrations } from './database/migrations/index.js';
import { ServiceInfoController } from './service-info.controller.js';
import { TripLifecycleModule } from './modules/trip-lifecycle/trip-lifecycle.module.js';
import { SeatUsageModule } from './modules/seat-usage/seat-usage.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    TripLifecycleModule,
    SeatUsageModule,
    OutboxModule,
  ],
  controllers: [ServiceInfoController],
})
export class InventoryModule {}
