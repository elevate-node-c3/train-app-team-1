import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { RefreshToken } from '../../domain/refresh-token.js';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface RefreshTokenRepositoryPort {
  save(ctx: TransactionContext, token: RefreshToken): Promise<void>;
  update(ctx: TransactionContext, token: RefreshToken): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  findByHashForUpdate(
    ctx: TransactionContext,
    tokenHash: string,
  ): Promise<RefreshToken | null>;
  revokeBySession(
    ctx: TransactionContext,
    sessionId: string,
    at: Date,
  ): Promise<void>;
  revokeByAccount(
    ctx: TransactionContext,
    accountId: string,
    at: Date,
  ): Promise<void>;
}
