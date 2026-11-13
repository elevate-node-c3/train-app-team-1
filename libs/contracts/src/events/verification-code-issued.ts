import type { EventEnvelope, EventLanguage } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

/** Keep reset and verification codes separate so one cannot be used for the other. */
export type VerificationCodePurpose = 'sign_up' | 'password_reset';

export const VERIFICATION_CODE_PURPOSES: readonly VerificationCodePurpose[] = [
  'sign_up',
  'password_reset',
];

/**
 * Carry plaintext for email; identity's verification record stores only its hash.
 * Never log the code or save it in delivery records.
 */
export interface VerificationCodeIssuedPayloadV1 {
  accountId: string;
  email: string;
  code: string;
  purpose: VerificationCodePurpose;
  /** Stored account language, not an HTTP header. */
  language: EventLanguage;
  /** UTC issuance time in identity's transaction; delivery timing starts here. */
  issuedAt: string;
  /** UTC expiry; the consumer must not send expired codes. */
  expiresAt: string;
}

export const VERIFICATION_CODE_ISSUED_EVENT_TYPE =
  EVENT_TYPES.verificationCodeIssued;
export const VERIFICATION_CODE_ISSUED_VERSION = 1;

/** Deletion tests enforce required consumer fields; extra fields remain valid. */
export const VERIFICATION_CODE_ISSUED_PAYLOAD_KEYS = [
  'accountId',
  'email',
  'code',
  'purpose',
  'language',
  'issuedAt',
  'expiresAt',
] as const satisfies readonly (keyof VerificationCodeIssuedPayloadV1)[];

export type VerificationCodeIssuedEvent = EventEnvelope<
  typeof VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VerificationCodeIssuedPayloadV1
>;
