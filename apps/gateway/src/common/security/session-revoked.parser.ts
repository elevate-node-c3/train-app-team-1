import type {
  EventEnvelope,
  SessionRevokedPayloadV1,
} from '@app/contracts';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';

const REASONS = new Set([
  'sign_out',
  'password_reset',
  'refresh_reuse',
  'admin',
]);

/**
 * The gateway owns this parser because it owns the consequence: a malformed
 * revocation must be dead-lettered, not silently ignored. Error messages name
 * the offending field and never echo the payload.
 */
export function parseSessionRevokedPayload(
  envelope: EventEnvelope,
): SessionRevokedPayloadV1 {
  const payload = envelope.payload;
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new InvalidEventPayloadError(
      'The session-revoked payload must be an object',
    );
  }

  const record = payload as Record<string, unknown>;
  const accountId = nonEmpty(record, 'accountId');
  const sessionId = stringField(record, 'sessionId');
  const jti = stringField(record, 'jti');
  const expiresAt = instant(record, 'expiresAt');
  const revokedAt = instant(record, 'revokedAt');

  const reason = record.reason;
  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    throw new InvalidEventPayloadError(
      "The session-revoked payload field 'reason' is not supported",
    );
  }

  const allSessions = record.allSessions;
  if (allSessions !== undefined && typeof allSessions !== 'boolean') {
    throw new InvalidEventPayloadError(
      "The session-revoked payload field 'allSessions' must be a boolean",
    );
  }
  if (!sessionId && !jti && allSessions !== true) {
    throw new InvalidEventPayloadError(
      'The session-revoked payload must name a session, a token, or every session',
    );
  }

  return {
    accountId,
    sessionId,
    jti,
    expiresAt: expiresAt.toISOString(),
    reason: reason as SessionRevokedPayloadV1['reason'],
    revokedAt: revokedAt.toISOString(),
    ...(allSessions === true ? { allSessions: true } : {}),
  };
}

function nonEmpty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidEventPayloadError(
      `The session-revoked payload field '${key}' must be a non-empty string`,
    );
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new InvalidEventPayloadError(
      `The session-revoked payload field '${key}' must be a string`,
    );
  }
  return value;
}

function instant(record: Record<string, unknown>, key: string): Date {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new InvalidEventPayloadError(
      `The session-revoked payload field '${key}' must be an ISO-8601 timestamp`,
    );
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new InvalidEventPayloadError(
      `The session-revoked payload field '${key}' must be an ISO-8601 timestamp`,
    );
  }
  return new Date(timestamp);
}
