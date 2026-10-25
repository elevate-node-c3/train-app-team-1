import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { VerificationCode } from '../../domain/verification-code.js';

export const VERIFICATION_CODE_REPOSITORY = Symbol(
  'VERIFICATION_CODE_REPOSITORY',
);

/**
 * Only the hash and salt cross this boundary. The plaintext code reaches the
 * outbox inside the event payload and is never persisted by identity.
 */
export interface VerificationCodeRepositoryPort {
  save(ctx: TransactionContext, code: VerificationCode): Promise<void>;
  update(ctx: TransactionContext, code: VerificationCode): Promise<void>;
  findLatestLive(
    ctx: TransactionContext,
    accountId: string,
    purpose: VerificationCodePurpose,
    options?: { forUpdate?: boolean },
  ): Promise<VerificationCode | null>;
  /** Used by re-issue: every older live code for the purpose dies at once. */
  consumeLive(
    ctx: TransactionContext,
    accountId: string,
    purposes: VerificationCodePurpose[],
    at: Date,
  ): Promise<void>;
}
