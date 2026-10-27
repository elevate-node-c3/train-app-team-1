import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VERIFICATION_CODE_ISSUED_VERSION,
} from '@app/contracts';
import {
  MAX_VERIFICATION_CODE_TTL_SECONDS,
  buildVerificationCodeIssued,
} from './verification-code-issued.factory.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const ACCOUNT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'user@example.com',
  language: 'ar' as const,
};

describe('verification-code-issued event builder', () => {
  it('is deterministic and anchors the BR-03 clock at issuedAt', () => {
    const props = {
      eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      correlationId: 'corr-1',
      account: ACCOUNT,
      code: '483920',
      purpose: 'sign_up' as const,
      ttlSeconds: 600,
      issuedAt: NOW,
    };

    const event = buildVerificationCodeIssued(props);

    expect(event).toEqual(buildVerificationCodeIssued(props));
    expect(event.id).toBe(props.eventId);
    expect(event.type).toBe(VERIFICATION_CODE_ISSUED_EVENT_TYPE);
    expect(event.version).toBe(VERIFICATION_CODE_ISSUED_VERSION);
    expect(event.producer).toBe('identity');
    expect(event.occurredAt).toBe(event.payload.issuedAt);
    expect(event.payload).toEqual({
      accountId: ACCOUNT.id,
      email: 'user@example.com',
      code: '483920',
      purpose: 'sign_up',
      language: 'ar',
      issuedAt: '2026-10-24T10:00:00.000Z',
      expiresAt: '2026-10-24T10:10:00.000Z',
    });
  });

  it('shares the TTL guard with the issuer', () => {
    expect(() =>
      buildVerificationCodeIssued({
        eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        correlationId: 'corr-1',
        account: ACCOUNT,
        code: '483920',
        purpose: 'sign_up',
        ttlSeconds: MAX_VERIFICATION_CODE_TTL_SECONDS + 1,
        issuedAt: NOW,
      }),
    ).toThrow(/between 1 and 600/i);

    for (const ttlSeconds of [0, 1.5]) {
      expect(() =>
        buildVerificationCodeIssued({
          eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          correlationId: 'corr-1',
          account: ACCOUNT,
          code: '483920',
          purpose: 'sign_up',
          ttlSeconds,
          issuedAt: NOW,
        }),
      ).toThrow(/between 1 and 600/i);
    }
  });
});
