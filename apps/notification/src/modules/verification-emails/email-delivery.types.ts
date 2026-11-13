import type { VerificationCodePurpose } from '@app/contracts';

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
  /** Delivery timing starts in identity's sign-up transaction. */
  issuedAt: Date;
}

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
