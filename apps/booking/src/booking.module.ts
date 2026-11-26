import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { MessagingModule } from '@app/messaging';
import { ServiceInfoController } from './service-info.controller.js';
import { BookingDraftModule } from './modules/draft/booking-draft.module.js';
import { BookingFlowModule } from './modules/flow/booking-flow.module.js';
import { TicketsModule } from './modules/tickets/tickets.module.js';
import { migrations } from './database/migrations/index.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    MigrationModule,
    BookingDraftModule,
    BookingFlowModule,
    TicketsModule,
  ],
  controllers: [ServiceInfoController],
})
export class BookingModule {}
