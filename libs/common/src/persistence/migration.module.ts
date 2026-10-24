import { Module } from '@nestjs/common';
import { MigrationRunnerService } from './migration-runner.service.js';

/**
 * Imported by a service that owns migrations. It is not in `CommonModule` on
 * purpose: a service with no migrations should not open a connection or take a
 * lock at boot just by importing the shared module.
 *
 * `DataSourceInitializer` is not declared here — it comes from the global
 * `PersistenceModule`, because there must be exactly one of it.
 */
@Module({
  providers: [MigrationRunnerService],
  exports: [MigrationRunnerService],
})
export class MigrationModule {}
