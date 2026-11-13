import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { MessagingModule } from '@app/messaging';
import { migrations } from './database/migrations/index.js';
import { VerificationEmailsModule } from './modules/verification-emails/verification-emails.module.js';
import { ProfileCompletedModule } from './modules/profile-completed/profile-completed.module.js';
import { ServiceInfoController } from './service-info.controller.js';

/** Wires shared services and features; connections open only during startup. */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    MigrationModule,
    VerificationEmailsModule,
    ProfileCompletedModule,
  ],
  controllers: [ServiceInfoController],
})
export class NotificationModule {}
