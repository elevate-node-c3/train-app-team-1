import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule, createTypeOrmAsyncOptions } from '@app/common';
import { ContractsModule } from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import { ServiceInfoModule } from './modules/service-info/service-info.module.js';

/**
 * Root module: infrastructure wiring and feature modules only. Business
 * providers belong to the feature module that owns them (ADR-0007).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(createTypeOrmAsyncOptions()),
    CommonModule,
    ContractsModule,
    MessagingModule,
    ServiceInfoModule,
  ],
})
export class NotificationModule {}
