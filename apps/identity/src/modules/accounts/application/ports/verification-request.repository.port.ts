import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { VerificationRequest } from '../../domain/verification-request.js';

export const VERIFICATION_REQUEST_REPOSITORY = Symbol(
  'VERIFICATION_REQUEST_REPOSITORY',
);

export interface VerificationRequestRepositoryPort {
  record(ctx: TransactionContext, request: VerificationRequest): Promise<void>;
  latestForEmail(
    email: string,
    purpose: VerificationCodePurpose,
  ): Promise<VerificationRequest | null>;
  countSince(
    email: string,
    purpose: VerificationCodePurpose,
    since: Date,
  ): Promise<number>;
}
