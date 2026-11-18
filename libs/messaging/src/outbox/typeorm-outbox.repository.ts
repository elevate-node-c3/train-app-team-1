import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import type { OutboxPort } from './outbox.port.js';
import { appendParams, fromDbRow, type OutboxRow } from './outbox-row.js';
import {
  CLAIM_OUTBOX_SQL,
  INSERT_OUTBOX_BATCH_SQL,
  INSERT_OUTBOX_SQL,
  MARK_OUTBOX_BATCH_PUBLISHED_SQL,
  MARK_OUTBOX_PUBLISHED_SQL,
  RECORD_OUTBOX_FAILURE_SQL,
} from './outbox.sql.js';

/**
 * Reuse the caller's transaction for every write.
 * Relay claim, publish, and mark share the lock until broker confirmation.
 */
@Injectable()
export class TypeOrmOutboxRepository implements OutboxPort {
  constructor(private readonly initializer: DataSourceInitializer) {}

  async append(
    ctx: TransactionContext,
    envelope: EventEnvelope,
  ): Promise<void> {
    const p = appendParams(envelope);
    await entityManagerOf(ctx).query(INSERT_OUTBOX_SQL, [
      p.id,
      p.eventType,
      p.eventVersion,
      p.routingKey,
      JSON.stringify(p.payload),
      p.correlationId,
      p.producer,
      p.occurredAt,
    ]);
  }

  async appendBatch(
    ctx: TransactionContext,
    events: readonly EventEnvelope[],
  ): Promise<void> {
    if (events.length === 0) return;
    // One JSON parameter keeps large expiry batches in the domain transaction.
    await entityManagerOf(ctx).query(INSERT_OUTBOX_BATCH_SQL, [
      JSON.stringify(events.map(appendParams)),
    ]);
  }

  async claimBatch(
    ctx: TransactionContext,
    limit: number,
  ): Promise<OutboxRow[]> {
    const rows = (await entityManagerOf(ctx).query(CLAIM_OUTBOX_SQL, [
      limit,
    ])) as Record<string, unknown>[];
    return rows.map(fromDbRow);
  }

  async markPublished(ctx: TransactionContext, id: string): Promise<void> {
    await entityManagerOf(ctx).query(MARK_OUTBOX_PUBLISHED_SQL, [id]);
  }

  async markPublishedBatch(
    ctx: TransactionContext,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    // Called only for confirmed IDs, still under the original claim locks.
    await entityManagerOf(ctx).query(MARK_OUTBOX_BATCH_PUBLISHED_SQL, [ids]);
  }

  async recordFailure(
    ctx: TransactionContext,
    id: string,
    lastError: string,
    retryDelayMs: number,
  ): Promise<void> {
    await entityManagerOf(ctx).query(RECORD_OUTBOX_FAILURE_SQL, [
      id,
      retryDelayMs,
      lastError,
    ]);
  }

  /** Database configuration status for readiness and schema checks. */
  get dataSourceConfigured(): boolean {
    return this.initializer.isConfigured;
  }
}
