import type { EventEnvelope, EventLanguage } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

/**
 * Why a code was issued. Reset codes are purpose-separated from verification
 * codes, so a code mailed for one flow can never be replayed in the other.
 */
export type VerificationCodePurpose = 'sign_up' | 'password_reset';

export const VERIFICATION_CODE_PURPOSES: readonly VerificationCodePurpose[] = [
  'sign_up',
  'password_reset',
];

/**
 * The v1 payload. `code` is plaintext on purpose — identity stores only its
 * hash, and notification needs the value to put it in the mail. Every rule
 * about not persisting or logging it lives in ADR-0006.
 */
export interface VerificationCodeIssuedPayloadV1 {
  accountId: string;
  email: string;
  code: string;
  purpose: VerificationCodePurpose;
  /** The account's language. There is no HTTP request on the consumer side. */
  language: EventLanguage;
  /** ISO-8601 UTC, stamped inside the sign-up transaction: BR-03's clock start. */
  issuedAt: string;
  /** ISO-8601 UTC. The consumer must not send mail after this instant. */
  expiresAt: string;
}

export const VERIFICATION_CODE_ISSUED_EVENT_TYPE =
  EVENT_TYPES.verificationCodeIssued;
export const VERIFICATION_CODE_ISSUED_VERSION = 1;

/**
 * The keys the consumer requires. The contract test deletes each one in turn;
 * an additive field is not listed here and must keep parsing (ADR-0005).
 */
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
