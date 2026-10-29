import type { EventEnvelope, EventLanguage } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

export interface AccountRegisteredPayloadV1 {
  accountId: string;
  email: string;
  language: EventLanguage;
  registeredAt: string;
}

export const ACCOUNT_REGISTERED_EVENT_TYPE = EVENT_TYPES.accountRegistered;
export const ACCOUNT_REGISTERED_VERSION = 1;
export const ACCOUNT_REGISTERED_PAYLOAD_KEYS = [
  'accountId',
  'email',
  'language',
  'registeredAt',
] as const satisfies readonly (keyof AccountRegisteredPayloadV1)[];

export type AccountRegisteredEvent = EventEnvelope<
  typeof ACCOUNT_REGISTERED_EVENT_TYPE,
  AccountRegisteredPayloadV1
>;

export interface EmailVerifiedPayloadV1 {
  accountId: string;
  email: string;
  verifiedAt: string;
}

export const EMAIL_VERIFIED_EVENT_TYPE = EVENT_TYPES.emailVerified;
export const EMAIL_VERIFIED_VERSION = 1;
export const EMAIL_VERIFIED_PAYLOAD_KEYS = [
  'accountId',
  'email',
  'verifiedAt',
] as const satisfies readonly (keyof EmailVerifiedPayloadV1)[];

export type EmailVerifiedEvent = EventEnvelope<
  typeof EMAIL_VERIFIED_EVENT_TYPE,
  EmailVerifiedPayloadV1
>;

export interface SessionRevokedPayloadV1 {
  accountId: string;
  sessionId: string;
  /** The access token that was active when the caller signed out, if known. */
  jti: string;
  /** ISO-8601; the revocation marker needs no TTL beyond this instant. */
  expiresAt: string;
  reason: 'sign_out' | 'password_reset' | 'refresh_reuse' | 'admin';
  revokedAt: string;
  /**
   * Additive (v1-compatible): a password reset revokes every session of the
   * account in one event, and the gateway must reject any access token minted
   * before it. Older consumers ignore the field and still revoke `sessionId`.
   */
  allSessions?: boolean;
}

export const SESSION_REVOKED_EVENT_TYPE = EVENT_TYPES.sessionRevoked;
export const SESSION_REVOKED_VERSION = 1;
export const SESSION_REVOKED_PAYLOAD_KEYS = [
  'accountId',
  'sessionId',
  'jti',
  'expiresAt',
  'reason',
  'revokedAt',
] as const satisfies readonly (keyof SessionRevokedPayloadV1)[];

export type SessionRevokedEvent = EventEnvelope<
  typeof SESSION_REVOKED_EVENT_TYPE,
  SessionRevokedPayloadV1
>;

export interface PasswordResetPayloadV1 {
  accountId: string;
  resetAt: string;
}

export const PASSWORD_RESET_EVENT_TYPE = EVENT_TYPES.passwordReset;
export const PASSWORD_RESET_VERSION = 1;
export const PASSWORD_RESET_PAYLOAD_KEYS = [
  'accountId',
  'resetAt',
] as const satisfies readonly (keyof PasswordResetPayloadV1)[];

export type PasswordResetEvent = EventEnvelope<
  typeof PASSWORD_RESET_EVENT_TYPE,
  PasswordResetPayloadV1
>;
