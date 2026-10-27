import {
  ACCOUNT_REGISTERED_EVENT_TYPE,
  ACCOUNT_REGISTERED_VERSION,
  EMAIL_VERIFIED_EVENT_TYPE,
  EMAIL_VERIFIED_VERSION,
  PASSWORD_RESET_EVENT_TYPE,
  PASSWORD_RESET_VERSION,
  SESSION_REVOKED_EVENT_TYPE,
  SESSION_REVOKED_VERSION,
  type AccountRegisteredEvent,
  type EmailVerifiedEvent,
  type PasswordResetEvent,
  type SessionRevokedEvent,
} from '@app/contracts';

interface EnvelopeProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  producer?: string;
}

function envelope(props: EnvelopeProps) {
  return {
    id: props.eventId,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: props.producer ?? 'identity',
  };
}

export function buildAccountRegistered(
  props: EnvelopeProps & {
    accountId: string;
    email: string;
    language: 'ar' | 'en';
  },
): AccountRegisteredEvent {
  return {
    ...envelope(props),
    type: ACCOUNT_REGISTERED_EVENT_TYPE,
    version: ACCOUNT_REGISTERED_VERSION,
    payload: {
      accountId: props.accountId,
      email: props.email,
      language: props.language,
      registeredAt: props.occurredAt.toISOString(),
    },
  };
}

export function buildEmailVerified(
  props: EnvelopeProps & { accountId: string; email: string },
): EmailVerifiedEvent {
  return {
    ...envelope(props),
    type: EMAIL_VERIFIED_EVENT_TYPE,
    version: EMAIL_VERIFIED_VERSION,
    payload: {
      accountId: props.accountId,
      email: props.email,
      verifiedAt: props.occurredAt.toISOString(),
    },
  };
}

export function buildSessionRevoked(
  props: EnvelopeProps & {
    accountId: string;
    sessionId: string;
    jti: string;
    expiresAt: Date;
    reason: 'sign_out' | 'password_reset' | 'refresh_reuse' | 'admin';
    /** True when every session of the account is revoked at once. */
    allSessions?: boolean;
  },
): SessionRevokedEvent {
  return {
    ...envelope(props),
    type: SESSION_REVOKED_EVENT_TYPE,
    version: SESSION_REVOKED_VERSION,
    payload: {
      accountId: props.accountId,
      sessionId: props.sessionId,
      jti: props.jti,
      expiresAt: props.expiresAt.toISOString(),
      reason: props.reason,
      revokedAt: props.occurredAt.toISOString(),
      ...(props.allSessions ? { allSessions: true } : {}),
    },
  };
}

export function buildPasswordReset(
  props: EnvelopeProps & { accountId: string },
): PasswordResetEvent {
  return {
    ...envelope(props),
    type: PASSWORD_RESET_EVENT_TYPE,
    version: PASSWORD_RESET_VERSION,
    payload: {
      accountId: props.accountId,
      resetAt: props.occurredAt.toISOString(),
    },
  };
}
