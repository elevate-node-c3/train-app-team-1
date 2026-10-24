import {
  VERIFICATION_CODE_ISSUED_PAYLOAD_KEYS,
  VERIFICATION_CODE_PURPOSES,
  type EventEnvelope,
  type EventLanguage,
  type VerificationCodeIssuedPayloadV1,
  type VerificationCodePurpose,
} from '@app/contracts';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';

/**
 * The consumer-owned contract. It is deliberately hand-written rather than
 * derived from the producer's TypeScript type: the type disappears at runtime,
 * and the whole point of the sweep below is to catch a producer that stopped
 * emitting a field the handler needs.
 *
 * Error messages name the offending field but never echo its value. This
 * payload can carry a live verification code and a real email address, and a
 * dead-letter reason is persisted and shown in an operator console.
 */
export function parseVerificationCodeIssuedPayload(
  envelope: EventEnvelope,
): VerificationCodeIssuedPayloadV1 {
  const payload = envelope.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new InvalidEventPayloadError(
      'The verification-code payload must be an object',
    );
  }

  const record = payload as Record<string, unknown>;
  for (const key of VERIFICATION_CODE_ISSUED_PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new InvalidEventPayloadError(
        `The verification-code payload is missing '${key}'`,
      );
    }
  }

  const accountId = nonEmptyString(record, 'accountId');
  const email = nonEmptyString(record, 'email');
  if (!email.includes('@')) {
    throw new InvalidEventPayloadError(
      "The verification-code payload field 'email' must be an email address",
    );
  }

  const code = nonEmptyString(record, 'code');

  const rawPurpose = record.purpose;
  if (
    typeof rawPurpose !== 'string' ||
    !VERIFICATION_CODE_PURPOSES.includes(rawPurpose as VerificationCodePurpose)
  ) {
    throw new InvalidEventPayloadError(
      "The verification-code payload field 'purpose' is not supported",
    );
  }

  // An unknown locale is a catalogue miss, not a reason to dead-letter a real
  // sign-up. BR-56 already defines Arabic as the fallback (ADR-0006).
  const language: EventLanguage = record.language === 'en' ? 'en' : 'ar';

  const issuedAt = instant(record, 'issuedAt');
  const expiresAt = instant(record, 'expiresAt');
  if (expiresAt.getTime() <= issuedAt.getTime()) {
    throw new InvalidEventPayloadError(
      "The verification-code payload field 'expiresAt' must be after 'issuedAt'",
    );
  }

  return {
    accountId,
    email,
    code,
    purpose: rawPurpose as VerificationCodePurpose,
    language,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function nonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidEventPayloadError(
      `The verification-code payload field '${key}' must be a non-empty string`,
    );
  }
  return value;
}

function instant(record: Record<string, unknown>, key: string): Date {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new InvalidEventPayloadError(
      `The verification-code payload field '${key}' must be an ISO-8601 timestamp`,
    );
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new InvalidEventPayloadError(
      `The verification-code payload field '${key}' must be an ISO-8601 timestamp`,
    );
  }
  return new Date(timestamp);
}
