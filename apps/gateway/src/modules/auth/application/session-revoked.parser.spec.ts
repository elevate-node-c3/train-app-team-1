import { describe, expect, it } from 'vitest';
import {
  SESSION_REVOKED_EVENT_TYPE,
  SESSION_REVOKED_VERSION,
  type EventEnvelope,
} from '@app/contracts';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';
import { parseSessionRevokedPayload } from './session-revoked.parser.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');

function envelope(
  payload: Record<string, unknown> = {},
): EventEnvelope {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: SESSION_REVOKED_EVENT_TYPE,
    version: SESSION_REVOKED_VERSION,
    occurredAt: NOW.toISOString(),
    correlationId: 'corr-1',
    producer: 'identity',
    payload: {
      accountId: 'account-1',
      sessionId: 'session-1',
      jti: 'jti-1',
      expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
      reason: 'sign_out',
      revokedAt: NOW.toISOString(),
      ...payload,
    },
  };
}

function invalid(envelopeValue: EventEnvelope, field?: string): void {
  let caught: unknown;
  try {
    parseSessionRevokedPayload(envelopeValue);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidEventPayloadError);
  if (field) expect((caught as Error).message).toContain(field);
}

describe('Session-revoked parser (F6c, BR-07)', () => {
  it('parses a sign-out revocation', () => {
    expect(parseSessionRevokedPayload(envelope())).toEqual({
      accountId: 'account-1',
      sessionId: 'session-1',
      jti: 'jti-1',
      expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
      reason: 'sign_out',
      revokedAt: NOW.toISOString(),
    });
  });

  it('parses the additive account-wide reset flag', () => {
    const parsed = parseSessionRevokedPayload(
      envelope({ allSessions: true, reason: 'password_reset' }),
    );

    expect(parsed.allSessions).toBe(true);
    expect(parsed.reason).toBe('password_reset');
  });

  it('accepts an additive field from a newer producer', () => {
    const parsed = parseSessionRevokedPayload(
      envelope({ futureField: 'ignored' }),
    );

    expect(parsed.sessionId).toBe('session-1');
  });

  it('allows an account-wide revocation without a session or jti', () => {
    const parsed = parseSessionRevokedPayload(
      envelope({ sessionId: '', jti: '', allSessions: true }),
    );

    expect(parsed.allSessions).toBe(true);
  });

  it('requires at least one revocation target', () => {
    invalid(envelope({ sessionId: '', jti: '' }));
  });

  it.each([
    ['accountId', 42],
    ['accountId', ''],
    ['sessionId', 42],
    ['jti', null],
    ['expiresAt', 'yesterday'],
    ['expiresAt', 123],
    ['revokedAt', 'not-a-date'],
    ['reason', 'because'],
    ['reason', 7],
    ['allSessions', 'true'],
  ])('rejects an invalid %s', (field, value) => {
    invalid(envelope({ [field]: value }), field);
  });

  it('never echoes the payload in a validation error', () => {
    let message = '';
    try {
      parseSessionRevokedPayload(
        envelope({ reason: 'admin-secret-account-1', jti: 'super-secret-jti' }),
      );
    } catch (error: unknown) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('super-secret-jti');
    expect(message).not.toContain('admin-secret-account-1');
  });

  it('rejects a non-object payload', () => {
    invalid({ ...envelope(), payload: 'not-an-object' });
  });
});
