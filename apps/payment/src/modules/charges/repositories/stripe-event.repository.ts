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

  async markRejected(id: string, error: string): Promise<void> {
    await this.events.update(
      { id },
      { processedAt: new Date(), lastError: error },
    );
  }

  async markProcessed(id: string, ctx?: TransactionContext): Promise<void> {
    const events = ctx
      ? entityManagerOf(ctx).getRepository(StripeEventEntity)
      : this.events;
    await events.update({ id }, { processedAt: new Date() });
  }
}
