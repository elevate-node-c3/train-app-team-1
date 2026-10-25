import type { VerificationCodePurpose } from '@app/contracts';

/** One code issuance, including for an address with no account. */
export class VerificationRequest {
  constructor(
    readonly id: string,
    readonly email: string,
    readonly accountId: string | null,
    readonly purpose: VerificationCodePurpose,
    readonly issuedAt: Date,
  ) {}
}

export const VERIFICATION_RESEND_WAIT_SECONDS = 120;
export const VERIFICATION_HOURLY_LIMIT = 5;
export const VERIFICATION_WINDOW_SECONDS = 60 * 60;
