import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { ContractsModule } from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import { NotificationController } from './transport/notification.controller.js';
import { NotificationService } from './domain/notification.service.js';
import { NotificationRepository } from './persistence/notification.repository.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    ContractsModule,
    MessagingModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationRepository],
  exports: [NotificationService],
})
export class NotificationModule {}
