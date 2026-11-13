import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSourceInitializer } from './data-source-initializer.js';
import { SchemaReadinessGate } from './schema-readiness.gate.js';

/** Database-scoped key keeps services from blocking each other's migrations. */
const LOCK_KEY_SQL = `hashtext('migrations:' || current_database())`;

@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationRunnerService.name);
  private completed = false;

  // Close the gate during construction, before any lifecycle hook runs.
  constructor(
    private readonly initializer: DataSourceInitializer,
    private readonly schema: SchemaReadinessGate,
  ) {
    this.schema.expectMigrations();
  }

  /** True once migrations have been applied in this process. */
  get hasCompleted(): boolean {
    return this.completed;
  }

  /**
   * Run explicitly at bootstrap: Nest uses manual initialization, so
   * migrationsRun does not run automatically. Log failures without aborting
   * boot; readiness reports the database as not ready.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.initializer.isConfigured) {
      this.schema.markSettled();
      return;
    }
    try {
      await this.run();
    } catch (error: unknown) {
      this.logger.error(
        { err: error },
        'Migrations did not run; the service is up but its schema may be stale',
      );
    } finally {
      // Open the gate even on failure, or waiters stall forever.
      this.schema.markSettled();
    }
  }

  async run(): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();

    if (dataSource.migrations.length === 0) {
      this.completed = true;
      return;
    }

    // Session advisory locks must be acquired and released on the same
    // connection, not on whichever pooled connection dataSource.query() uses.
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Block concurrent instances until migrations finish; never skip them.
      // TypeORM's migrations table does not serialize concurrent runs.
      await queryRunner.query(`SELECT pg_advisory_lock(${LOCK_KEY_SQL})`);

      const applied = await dataSource.runMigrations({ transaction: 'each' });
      this.completed = true;

      if (applied.length > 0) {
        this.logger.log(
          `Applied ${applied.length} migration(s): ${applied
            .map((migration) => migration.name)
            .join(', ')}`,
        );
      }
    } finally {
      // Unlock errors must not hide a migration failure.
      try {
        await queryRunner.query(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
      } catch (error: unknown) {
        this.logger.warn(
          { err: error },
          'Failed to release the migration advisory lock; it will be freed when the connection closes',
        );
      }
      // Never `destroy()` the DataSource here: the application owns that pool.
      await queryRunner.release();
    }
  }
}
