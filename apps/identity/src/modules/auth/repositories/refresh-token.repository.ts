import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';

@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly dataSource: DataSource) {}

  async save(
    ctx: TransactionContext,
    token: RefreshTokenEntity,
  ): Promise<void> {
    await entityManagerOf(ctx).getRepository(RefreshTokenEntity).insert(token);
  }

  async update(
    ctx: TransactionContext,
    token: RefreshTokenEntity,
  ): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(RefreshTokenEntity)
      .update({ id: token.id }, token);
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenEntity | null> {
    return this.dataSource
      .getRepository(RefreshTokenEntity)
      .findOne({ where: { tokenHash } });
  }

  async findByHashForUpdate(
    ctx: TransactionContext,
    tokenHash: string,
  ): Promise<RefreshTokenEntity | null> {
    return entityManagerOf(ctx)
      .getRepository(RefreshTokenEntity)
      .createQueryBuilder('token')
      .setLock('pessimistic_write')
      .where('token.tokenHash = :tokenHash', { tokenHash })
      .getOne();
  }

  async revokeBySession(
    ctx: TransactionContext,
    sessionId: string,
    at: Date,
  ): Promise<void> {
    await entityManagerOf(ctx).query(
      `
        UPDATE refresh_token
           SET status = 'revoked', revoked_at = $2
         WHERE session_id = $1
           AND status <> 'revoked'
      `,
      [sessionId, at],
    );
  }

  async revokeByAccount(
    ctx: TransactionContext,
    accountId: string,
    at: Date,
  ): Promise<void> {
    await entityManagerOf(ctx).query(
      `
        UPDATE refresh_token token
           SET status = 'revoked', revoked_at = $2
          FROM session
         WHERE token.session_id = session.id
           AND session.account_id = $1
           AND token.status <> 'revoked'
      `,
      [accountId, at],
    );
  }
}
