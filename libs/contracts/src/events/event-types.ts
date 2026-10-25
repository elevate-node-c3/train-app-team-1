/**
 * Every event type on the backbone. The string doubles as the topic routing
 * key, so it reads `<producer>.<aggregate>.<what-happened>`.
 *
 * Routing keys carry no version. An unreadable version is a dead-letter
 * decision, not a routing one — the consumer has to see the message to report
 * why it could not read it. A deliberately breaking change takes a new key
 * (`...issued.v2`) so old and new consumers can run side by side.
 */
export const EVENT_TYPES = {
  verificationCodeIssued: 'identity.verification-code.issued',
  accountRegistered: 'identity.account.registered',
  emailVerified: 'identity.email.verified',
  sessionRevoked: 'identity.session.revoked',
  passwordReset: 'identity.password.reset',
} as const;

export type EventTypeName = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
