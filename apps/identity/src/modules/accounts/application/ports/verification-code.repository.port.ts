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
}
