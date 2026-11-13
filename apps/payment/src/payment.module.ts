import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { MessagingModule } from '@app/messaging';
import { ServiceInfoController } from './service-info.controller.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    MessagingModule,
  ],
  controllers: [ServiceInfoController],
})
export class PaymentModule {}
