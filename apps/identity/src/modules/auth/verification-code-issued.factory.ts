import {
  VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VERIFICATION_CODE_ISSUED_VERSION,
  type EventLanguage,
  type VerificationCodeIssuedEvent,
  type VerificationCodePurpose,
} from '@app/contracts';
/** Enforce the TTL cap in the producer too, not only in Joi. */
export const MAX_VERIFICATION_CODE_TTL_SECONDS = 600;

export interface VerificationCodeIssuedFactoryProps {
  eventId: string;
  correlationId: string;
  account: {
    id: string;
    email: string;
    language: EventLanguage;
  };
  code: string;
  purpose: VerificationCodePurpose;
  ttlSeconds: number;
  issuedAt: Date;
  producer?: string;
}

/**
 * occurredAt and payload.issuedAt match: delivery latency starts at issuance,
 * not publication.
 */
export function buildVerificationCodeIssued(
  props: VerificationCodeIssuedFactoryProps,
): VerificationCodeIssuedEvent {
  if (
    !Number.isInteger(props.ttlSeconds) ||
    props.ttlSeconds < 1 ||
    props.ttlSeconds > MAX_VERIFICATION_CODE_TTL_SECONDS
  ) {
    throw new Error(
      `Verification code TTL must be between 1 and ${MAX_VERIFICATION_CODE_TTL_SECONDS} seconds`,
    );
  }

  const issuedAt = props.issuedAt.toISOString();
  const expiresAt = new Date(
    props.issuedAt.getTime() + props.ttlSeconds * 1000,
  ).toISOString();

  return {
    id: props.eventId,
    type: VERIFICATION_CODE_ISSUED_EVENT_TYPE,
    version: VERIFICATION_CODE_ISSUED_VERSION,
    occurredAt: issuedAt,
    correlationId: props.correlationId,
    producer: props.producer ?? 'identity',
    payload: {
      accountId: props.account.id,
      email: props.account.email,
      code: props.code,
      purpose: props.purpose,
      language: props.account.language,
      issuedAt,
      expiresAt,
    },
  };
}
