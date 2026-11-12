import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Nest uses manual initialization. All callers share one initialize() promise
 * to avoid connection races. Failures clear it so the next caller can retry.
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
   * Returns the connected DataSource. Driver errors must be reported as
   * degraded health, not crash the service.
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
