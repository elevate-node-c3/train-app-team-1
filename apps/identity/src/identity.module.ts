import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CommonModule,
  MigrationModule,
  createTypeOrmAsyncOptions,
} from '@app/common';
import { MessagingModule, OutboxModule } from '@app/messaging';
import { migrations } from './database/migrations/index.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { ServiceInfoController } from './service-info.controller.js';

/**
 * Root module: infrastructure wiring and feature modules only. Business
 * providers belong to the feature module that owns them.
 *
 * The migration list is passed to the same DataSource the unit of work uses;
 * `MigrationRunnerService` applies it at bootstrap and no provider connects in
 * its constructor (the skeleton test compiles this module without Docker).
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
    AccountsModule,
  ],
  controllers: [ServiceInfoController],
})
export class IdentityModule {}
