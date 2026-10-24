import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * The one place that calls `dataSource.initialize()`.
 *
 * `manualInitialization: true` (see typeorm.config.ts) means Nest never
 * connects the DataSource, so whoever needs it first has to. Two callers
 * racing throws `CannotConnectAlreadyConnectedError`, and there are several:
 * the readiness probe, the unit of work, and the migration runner. They all go
 * through this and await the same promise.
 *
 * A failed attempt clears the promise so the next caller retries — a Postgres
 * outage at boot must not be cached as permanent, because the platform
 * degrades rather than crash-loops.
 */
@Injectable()
export class DataSourceInitializer {
  private readonly logger = new Logger(DataSourceInitializer.name);
  private initializing: Promise<void> | null = null;

  constructor(@Optional() private readonly dataSource?: DataSource) {}

  /** False in a service wired without a database. */
  get isConfigured(): boolean {
    return this.dataSource !== undefined;
  }

  /**
   * Resolves once the DataSource is connected. Rejects with the underlying
   * driver error, which callers are expected to turn into a degraded report
   * rather than a crash.
   */
  async ensureInitialized(): Promise<DataSource> {
    if (!this.dataSource) {
      throw new Error('No DataSource is configured for this service');
    }
    if (this.dataSource.isInitialized) {
      return this.dataSource;
    }

    this.initializing ??= this.dataSource
      .initialize()
      .then(() => {
        this.logger.log('Data source initialized');
      })
      .catch((error: unknown) => {
        this.initializing = null;
        throw error;
      });

    await this.initializing;
    return this.dataSource;
  }
}
