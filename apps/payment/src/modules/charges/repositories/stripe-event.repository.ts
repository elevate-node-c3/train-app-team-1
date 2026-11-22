import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { StripeEventEntity } from '../entities/stripe-event.entity.js';
import type { StripeEventRecord } from '../types/stripe-event.types.js';

@Injectable()
export class StripeEventRepository {
  constructor(
    @InjectRepository(StripeEventEntity)
    private readonly events: Repository<StripeEventEntity>,
  ) {}

  async record(event: StripeEventRecord): Promise<boolean> {
    const result = await this.events
      .createQueryBuilder()
      .insert()
      .into(StripeEventEntity)
      .values({
        id: event.id,
        type: event.type,
        objectId: event.objectId,
        payload: event.payload as QueryDeepPartialEntity<
          StripeEventEntity['payload']
        >,
        processedAt: null,
        attempts: 0,
        lastError: null,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    return (result.raw as Pick<StripeEventEntity, 'id'>[]).length > 0;
  }

  async findPending(limit: number): Promise<StripeEventRecord[]> {
    if (limit === 0) return [];
    return this.events.find({
      where: { processedAt: IsNull() },
      select: { id: true, type: true, objectId: true, payload: true },
      order: { receivedAt: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  async claimPending(
    ctx: TransactionContext,
  ): Promise<StripeEventRecord | undefined> {
    return (
      (await entityManagerOf(ctx)
        .getRepository(StripeEventEntity)
        .createQueryBuilder('event')
        .where('processed_at IS NULL AND next_attempt_at <= now()')
        .orderBy('received_at', 'ASC')
        .addOrderBy('id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(1)
        .getOne()) ?? undefined
    );
  }

  async markRejected(
    id: string,
    error: string,
    ctx?: TransactionContext,
  ): Promise<void> {
    const events = ctx
      ? entityManagerOf(ctx).getRepository(StripeEventEntity)
      : this.events;
    await events.update({ id }, { processedAt: new Date(), lastError: error });
  }

  async retry(
    id: string,
    error: string,
    ctx?: TransactionContext,
  ): Promise<void> {
    const events = ctx
      ? entityManagerOf(ctx).getRepository(StripeEventEntity)
      : this.events;
    await events
      .createQueryBuilder()
      .update()
      .set({
        attempts: () => 'attempts + 1',
        lastError: error,
        nextAttemptAt: () =>
          "now() + (LEAST(60, POWER(2, LEAST(attempts, 6))) * interval '1 second')",
      })
      .where('id = :id AND processed_at IS NULL', { id })
      .execute();
  }

  async markProcessed(id: string, ctx?: TransactionContext): Promise<void> {
    const events = ctx
      ? entityManagerOf(ctx).getRepository(StripeEventEntity)
      : this.events;
    await events.update({ id }, { processedAt: new Date(), lastError: null });
  }

  async recoveryCounts(): Promise<{
    pendingStripeEvents: number;
    rejectedStripeEvents: number;
  }> {
    const [row] = (await this.events.query(`SELECT
      count(*) FILTER (WHERE event.processed_at IS NULL) AS pending,
      count(*) FILTER (WHERE event.processed_at IS NOT NULL AND event.last_error IS NOT NULL
        AND (charge.id IS NULL OR charge.status = 'started')) AS rejected
      FROM stripe_event event LEFT JOIN payment_charge charge
        ON charge.stripe_payment_intent_id = event.object_id`)) as {
      pending: string;
      rejected: string;
    }[];
    return {
      pendingStripeEvents: Number(row.pending),
      rejectedStripeEvents: Number(row.rejected),
    };
  }
}
