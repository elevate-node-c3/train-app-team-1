import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSourceInitializer } from './data-source-initializer.js';

/**
 * Lock key derived from the database name, so the seven services never block
 * each other: each owns its own database and therefore its own key.
 */
const LOCK_KEY_SQL = `hashtext('migrations:' || current_database())`;

@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationRunnerService.name);
  private completed = false;

  constructor(private readonly initializer: DataSourceInitializer) {}

  /** True once migrations have been applied in this process. */
  get hasCompleted(): boolean {
    return this.completed;
  }

  /**
   * Runs at bootstrap rather than on a `migrationsRun: true` flag, which does
   * nothing here: that option only fires inside `initialize()`, and
   * `manualInitialization: true` means Nest never calls it.
   *
   * A failure is logged, not thrown. Throwing here would abort the boot, and
   * the platform's posture is that a Postgres outage yields a degraded
   * service: `/health/ready` already reports the database as not ready, which
   * is the honest signal. The alternative — a service that exits — gives a
   * crash loop and no diagnostics.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.initializer.isConfigured) {
      return;
    }
    try {
      await this.run();
    } catch (error: unknown) {
      this.logger.error(
        { err: error },
        'Migrations did not run; the service is up but its schema may be stale',
      );
    }
  }

  async run(): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();

    if (dataSource.migrations.length === 0) {
      this.completed = true;
      return;
    }

    // A dedicated connection, because a session-level advisory lock belongs to
    // the connection that took it. Going through `dataSource.query()` would
    // take the lock on one pooled connection and try to release it on
    // whichever one the pool handed back next, leaving the first holding it
    // for the life of the process.
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      // Blocking, not `pg_try_advisory_lock`: a second instance booting at the
      // same time should wait and then find nothing to do, rather than skip
      // migrating and start serving against a schema that is not there yet.
      // TypeORM's own `migrations` table carries no lock of its own, so two
      // concurrent `runMigrations()` would both attempt the same CREATE TABLE
      // and one would fail the boot.
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
      // Releasing the lock must not mask a migration failure, so this block
      // swallows its own errors only.
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
