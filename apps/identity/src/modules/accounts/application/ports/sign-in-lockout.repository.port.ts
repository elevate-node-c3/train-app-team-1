import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { SignInLockout } from '../../domain/sign-in-lockout.js';

export const SIGN_IN_LOCKOUT_REPOSITORY = Symbol(
  'SIGN_IN_LOCKOUT_REPOSITORY',
);

export interface SignInLockoutRepositoryPort {
  /** Outside a transaction, for the cheap "is this address locked" check. */
  find(email: string): Promise<SignInLockout | null>;
  findForUpdate(
    ctx: TransactionContext,
    email: string,
  ): Promise<SignInLockout | null>;
  save(ctx: TransactionContext, lockout: SignInLockout): Promise<void>;
}
