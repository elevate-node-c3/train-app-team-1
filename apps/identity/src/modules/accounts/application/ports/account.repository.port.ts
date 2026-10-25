import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { Account } from '../../domain/account.js';

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

/**
 * Persisting an account is a crossing, so it is a port. Every write takes the
 * caller's transaction context: the account row, the verification code and the
 * outbox row must commit together (ADR-0001), and only the use-case decides
 * where the transaction begins and ends.
 */
export interface AccountRepositoryPort {
  save(ctx: TransactionContext, account: Account): Promise<void>;
  update(ctx: TransactionContext, account: Account): Promise<void>;
  findByEmail(email: string): Promise<Account | null>;
  findById(id: string): Promise<Account | null>;
  findByEmailForUpdate(
    ctx: TransactionContext,
    email: string,
  ): Promise<Account | null>;
  findByIdForUpdate(
    ctx: TransactionContext,
    id: string,
  ): Promise<Account | null>;
}
