import { Injectable } from '@nestjs/common';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import type {
  ClaimEvent,
  ProcessedEventStorePort,
} from './processed-event.port.js';
import {
  CLAIM_PROCESSED_EVENT_SQL,
  MARK_PROCESSED_EVENT_FAILED_SQL,
  MARK_PROCESSED_EVENT_HANDLED_SQL,
  MARK_PROCESSED_EVENT_SKIPPED_SQL,
} from './processed-event.sql.js';

/**
 * Raw SQL on purpose: for this ledger the statement *is* the concurrency
 * design, and a TypeORM entity would hide the `ON CONFLICT ... WHERE` predicate
 * that makes deduplication correct.
 */
@Injectable()
export class TypeOrmProcessedEventStore implements ProcessedEventStorePort {
  constructor(private readonly initializer: DataSourceInitializer) {}

  async claim(event: ClaimEvent): Promise<number | null> {
    const dataSource = await this.initializer.ensureInitialized();
    const rows = (await dataSource.query(CLAIM_PROCESSED_EVENT_SQL, [
      event.eventId,
      event.eventType,
      event.redelivered,
      event.leaseSeconds,
    ])) as { attempt_count: number | string }[];

    if (rows.length === 0) {
      return null;
    }
    return Number(rows[0].attempt_count);
  }

  async markHandled(eventId: string): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();
    await dataSource.query(MARK_PROCESSED_EVENT_HANDLED_SQL, [eventId]);
  }

  async markSkipped(eventId: string, skipReason: string): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();
    await dataSource.query(MARK_PROCESSED_EVENT_SKIPPED_SQL, [
      eventId,
      skipReason,
    ]);
  }

  async markFailed(eventId: string, errorMessage: string): Promise<void> {
    const dataSource = await this.initializer.ensureInitialized();
    await dataSource.query(MARK_PROCESSED_EVENT_FAILED_SQL, [
      eventId,
      errorMessage,
    ]);
  }
}
