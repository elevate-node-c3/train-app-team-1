import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { MessagingModule, OutboxModule } from '@app/messaging';
import { migrations } from './database/migrations/index.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ServiceInfoController } from './service-info.controller.js';

/**
 * Run migrations at bootstrap on the unit of work's DataSource.
 * Constructors must not open connections.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    OutboxModule,
    MigrationModule,
    AuthModule,
  ],
  controllers: [ServiceInfoController],
})
export class IdentityModule {}
