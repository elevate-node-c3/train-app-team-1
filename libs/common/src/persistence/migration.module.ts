import { Module } from '@nestjs/common';
import { MigrationRunnerService } from './migration-runner.service.js';

/**
 * Only services with migrations import this, not CommonModule, so others do
 * not connect or lock at boot. Reuse the global DataSourceInitializer rather
 * than declaring a second instance here.
 */
@Module({
  providers: [MigrationRunnerService],
  exports: [MigrationRunnerService],
})
export class MigrationModule {}
