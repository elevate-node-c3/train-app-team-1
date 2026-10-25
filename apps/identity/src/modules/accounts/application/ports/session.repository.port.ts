import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { Session } from '../../domain/session.js';

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');

export interface SessionRepositoryPort {
  save(ctx: TransactionContext, session: Session): Promise<void>;
  update(ctx: TransactionContext, session: Session): Promise<void>;
  findById(id: string): Promise<Session | null>;
  findByIdForUpdate(
    ctx: TransactionContext,
    id: string,
  ): Promise<Session | null>;
  revokeByAccount(
    ctx: TransactionContext,
    accountId: string,
    reason: string,
    at: Date,
  ): Promise<string[]>;
}
