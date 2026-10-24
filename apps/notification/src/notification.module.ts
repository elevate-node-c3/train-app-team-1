import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { ContractsModule } from '@app/contracts';
import { MessagingModule } from '@app/messaging';
import { migrations } from './database/migrations/index.js';
import { ServiceInfoModule } from './modules/service-info/service-info.module.js';
import { VerificationEmailsModule } from './modules/verification-emails/verification-emails.module.js';

/**
 * Root module: infrastructure wiring and feature modules only. Business
 * providers belong to the feature module that owns them (ADR-0007).
 *
 * The migration list is passed to the same DataSource the consumer's store
 * uses; `MigrationRunnerService` applies it at bootstrap and no provider
 * connects in its constructor (the skeleton test compiles this module without
 * Docker).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    ContractsModule,
    MessagingModule,
    MigrationModule,
    VerificationEmailsModule,
    ServiceInfoModule,
  ],
})
export class NotificationModule {}
