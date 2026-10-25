import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { Session } from '../../domain/session.js';
import type { SessionRepositoryPort } from '../../application/ports/session.repository.port.js';
import { SessionOrmEntity } from './session.orm-entity.js';

function toDomain(row: SessionOrmEntity): Session {
  return Session.restore({
    id: row.id,
    accountId: row.accountId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    reuseDetectedAt: row.reuseDetectedAt,
  });
}

function toRow(session: Session): SessionOrmEntity {
  const row = new SessionOrmEntity();
  row.id = session.id;
  row.accountId = session.accountId;
  row.createdAt = session.createdAt;
  row.lastUsedAt = session.lastUsedAt;
  row.expiresAt = session.expiresAt;
  row.revokedAt = session.revokedAt;
  row.revokedReason = session.revokedReason;
  row.reuseDetectedAt = session.reuseDetectedAt;
  return row;
}

@Injectable()
export class TypeOrmSessionRepository implements SessionRepositoryPort {
  constructor(private readonly dataSource: DataSource) {}

  async save(ctx: TransactionContext, session: Session): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(SessionOrmEntity)
      .insert(toRow(session));
  }

  async update(ctx: TransactionContext, session: Session): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(SessionOrmEntity)
      .update({ id: session.id }, toRow(session));
  }

  async findById(id: string): Promise<Session | null> {
    const row = await this.dataSource
      .getRepository(SessionOrmEntity)
      .findOne({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByIdForUpdate(
    ctx: TransactionContext,
    id: string,
  ): Promise<Session | null> {
    const row = await entityManagerOf(ctx)
      .getRepository(SessionOrmEntity)
      .createQueryBuilder('session')
      .setLock('pessimistic_write')
      .where('session.id = :id', { id })
      .getOne();
    return row ? toDomain(row) : null;
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
