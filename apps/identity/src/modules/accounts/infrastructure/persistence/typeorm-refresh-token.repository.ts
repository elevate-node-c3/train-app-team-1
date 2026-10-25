import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { RefreshToken } from '../../domain/refresh-token.js';
import type { RefreshTokenRepositoryPort } from '../../application/ports/refresh-token.repository.port.js';
import { RefreshTokenOrmEntity } from './refresh-token.orm-entity.js';

function toDomain(row: RefreshTokenOrmEntity): RefreshToken {
  return RefreshToken.restore({
    id: row.id,
    sessionId: row.sessionId,
    tokenHash: row.tokenHash,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    rotatedAt: row.rotatedAt,
    replacedById: row.replacedById,
    gracePayload: row.gracePayload,
    graceExpiresAt: row.graceExpiresAt,
    revokedAt: row.revokedAt,
  });
}

function toRow(token: RefreshToken): RefreshTokenOrmEntity {
  const row = new RefreshTokenOrmEntity();
  row.id = token.id;
  row.sessionId = token.sessionId;
  row.tokenHash = token.tokenHash;
  row.status = token.status;
  row.issuedAt = token.issuedAt;
  row.expiresAt = token.expiresAt;
  row.rotatedAt = token.rotatedAt;
  row.replacedById = token.replacedById;
  row.gracePayload = token.gracePayload;
  row.graceExpiresAt = token.graceExpiresAt;
  row.revokedAt = token.revokedAt;
  return row;
}

@Injectable()
export class TypeOrmRefreshTokenRepository
  implements RefreshTokenRepositoryPort
{
  constructor(private readonly dataSource: DataSource) {}

  async save(ctx: TransactionContext, token: RefreshToken): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(RefreshTokenOrmEntity)
      .insert(toRow(token));
  }

  async update(ctx: TransactionContext, token: RefreshToken): Promise<void> {
    await entityManagerOf(ctx)
      .getRepository(RefreshTokenOrmEntity)
      .update({ id: token.id }, toRow(token));
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.dataSource
      .getRepository(RefreshTokenOrmEntity)
      .findOne({ where: { tokenHash } });
    return row ? toDomain(row) : null;
  }

  async findByHashForUpdate(
    ctx: TransactionContext,
    tokenHash: string,
  ): Promise<RefreshToken | null> {
    const row = await entityManagerOf(ctx)
      .getRepository(RefreshTokenOrmEntity)
      .createQueryBuilder('token')
      .setLock('pessimistic_write')
      .where('token.tokenHash = :tokenHash', { tokenHash })
      .getOne();
    return row ? toDomain(row) : null;
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
