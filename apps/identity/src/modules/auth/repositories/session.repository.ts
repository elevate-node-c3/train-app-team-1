import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { SessionEntity } from '../entities/session.entity.js';

@Injectable()
export class SessionRepository {
  constructor(private readonly dataSource: DataSource) {}

  async save(ctx: TransactionContext, session: SessionEntity): Promise<void> {
    await entityManagerOf(ctx).getRepository(SessionEntity).insert(session);
  }

  async update(ctx: TransactionContext, session: SessionEntity): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(SessionEntity)
      .update({ id: session.id }, session);
  }

  async findById(id: string): Promise<SessionEntity | null> {
    return this.dataSource
      .getRepository(SessionEntity)
      .findOne({ where: { id } });
  }

  async findByIdForUpdate(
    ctx: TransactionContext,
    id: string,
  ): Promise<SessionEntity | null> {
    return entityManagerOf(ctx)
      .getRepository(SessionEntity)
      .createQueryBuilder('session')
      .setLock('pessimistic_write')
      .where('session.id = :id', { id })
      .getOne();
  }

  /**
   * Returns the ids of the sessions this call revoked, so the caller can
   * publish one revocation marker per session without a second read.
   */
  async revokeByAccount(
    ctx: TransactionContext,
    accountId: string,
    reason: string,
    at: Date,
  ): Promise<string[]> {
    const rows = (await entityManagerOf(ctx).query(
      `
        UPDATE session
           SET revoked_at = $2, revoked_reason = $3
         WHERE account_id = $1
           AND revoked_at IS NULL
        RETURNING id
      `,
      [accountId, at, reason],
    )) as { id: string }[];
    return rows.map((row) => row.id);
  }
}
