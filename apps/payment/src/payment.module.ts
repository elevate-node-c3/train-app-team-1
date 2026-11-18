import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  createTypeOrmAsyncOptions,
  MigrationModule,
} from '@app/common';
import { MessagingModule } from '@app/messaging';
import { ServiceInfoController } from './service-info.controller.js';
import { migrations } from './database/migrations/index.js';
import { ChargesModule } from './modules/charges/charges.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    MigrationModule,
    ChargesModule,
  ],
  controllers: [ServiceInfoController],
})
export class PaymentModule {}
