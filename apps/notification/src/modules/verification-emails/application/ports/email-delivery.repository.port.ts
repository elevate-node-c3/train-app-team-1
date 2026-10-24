import type { VerificationCodePurpose } from '@app/contracts';

export const EMAIL_DELIVERY_REPOSITORY = Symbol('EMAIL_DELIVERY_REPOSITORY');

export const EMAIL_DELIVERY_OUTCOMES = [
  'accepted',
  'skipped_expired',
  'failed',
] as const;

export type EmailDeliveryOutcome = (typeof EMAIL_DELIVERY_OUTCOMES)[number];

interface EmailDeliveryBase {
  eventId: string;
  accountId: string;
  recipientEmail: string;
  purpose: VerificationCodePurpose;
  /** BR-03's clock start: stamped by identity inside the sign-up transaction. */
  issuedAt: Date;
}

/**
 * The outcome is a discriminated union so an `accepted` row cannot be built
 * without the measurement the database CHECK also requires.
 */
export type EmailDeliveryRecord =
  | (EmailDeliveryBase & {
      outcome: 'accepted';
      acceptedAt: Date;
      latencyMs: number;
    })
  | (EmailDeliveryBase & {
      outcome: 'skipped_expired';
      skipReason: string;
    })
  | (EmailDeliveryBase & {
      outcome: 'failed';
      errorMessage: string;
    });

export interface EmailDeliveryRepositoryPort {
  record(delivery: EmailDeliveryRecord): Promise<void>;
}
