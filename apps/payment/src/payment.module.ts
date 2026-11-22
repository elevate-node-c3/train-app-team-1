import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  createTypeOrmAsyncOptions,
  MigrationModule,
} from '@app/common';
import { MessagingModule, OutboxModule } from '@app/messaging';
import { ServiceInfoController } from './service-info.controller.js';
import { migrations } from './database/migrations/index.js';
import { ChargesModule } from './modules/charges/charges.module.js';
import { CardsModule } from './modules/cards/cards.module.js';
import { ChargesPersistenceModule } from './modules/charges/charges-persistence.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    OutboxModule,
    MigrationModule,
    ChargesModule,
    CardsModule,
    ChargesPersistenceModule,
  ],
  controllers: [ServiceInfoController],
})
export class PaymentModule {}
