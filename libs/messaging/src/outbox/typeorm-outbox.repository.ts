import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import type { OutboxPort } from './outbox.port.js';
import { appendParams, fromDbRow, type OutboxRow } from './outbox-row.js';
import {
  CLAIM_OUTBOX_SQL,
  INSERT_OUTBOX_SQL,
  MARK_OUTBOX_PUBLISHED_SQL,
  RECORD_OUTBOX_FAILURE_SQL,
} from './outbox.sql.js';

/**
 * The outbox adapter. Every method takes a `TransactionContext`: `append` joins
 * the sign-up transaction, and the relay's claim/publish/mark sequence joins
 * one relay transaction so the row lock is held until the confirm resolves.
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

  async recordFailure(
    ctx: TransactionContext,
    id: string,
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await entityManagerOf(ctx).query(RECORD_OUTBOX_FAILURE_SQL, [
      id,
      nextAttemptAt.toISOString(),
      lastError,
    ]);
  }

  /** Used by the readiness probe's tests and by schema checks. */
  get dataSourceConfigured(): boolean {
    return this.initializer.isConfigured;
  }
}
