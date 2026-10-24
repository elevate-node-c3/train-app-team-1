import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CODE_ISSUED_EVENT_TYPE,
  VERIFICATION_CODE_ISSUED_VERSION,
} from '@app/contracts';
import { Account } from './account.js';
import {
  MAX_VERIFICATION_CODE_TTL_SECONDS,
  VerificationCode,
} from './verification-code.js';
import {
  generateVerificationCode,
  verifyVerificationCode,
} from './verification-code.hashing.js';
import { buildVerificationCodeIssued } from './events/verification-code-issued.factory.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');

function registered(): Account {
  return Account.register({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: '  User@Example.COM ',
    createdAt: NOW,
  });
}

describe('Account aggregate', () => {
  it('normalizes the email and defaults the language to Arabic', () => {
    const account = registered();

    expect(account.email).toBe('user@example.com');
    expect(account.language).toBe('ar');
    expect(account.status).toBe('pending');
    expect(account.isPending()).toBe(true);
    expect(account.createdAt).toBe(NOW);
  });

  it('keeps an explicitly requested language', () => {
    const account = Account.register({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      email: 'user@example.com',
      language: 'en',
    });

    expect(account.language).toBe('en');
  });

  it('rejects an address without an @', () => {
    expect(() =>
      Account.register({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'nope' }),
    ).toThrow(/valid email/i);
  });
});

describe('VerificationCode aggregate', () => {
  function issue(overrides: Partial<Parameters<typeof VerificationCode.issue>[0]> = {}) {
    return VerificationCode.issue({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      accountId: registered().id,
      purpose: 'sign_up',
      code: '483920',
      ttlSeconds: 600,
      issuedAt: NOW,
      ...overrides,
    });
  }

  it('expires exactly ttl seconds after issue time', () => {
    const code = issue();

    expect(code.issuedAt).toBe(NOW);
    expect(code.expiresAt.toISOString()).toBe('2026-10-24T10:10:00.000Z');
    expect(code.isExpired(new Date('2026-10-24T09:59:59.999Z'))).toBe(false);
    expect(code.isExpired(new Date('2026-10-24T10:10:00.000Z'))).toBe(true);
  });

  it(`rejects a TTL above ${MAX_VERIFICATION_CODE_TTL_SECONDS} seconds`, () => {
    expect(() => issue({ ttlSeconds: MAX_VERIFICATION_CODE_TTL_SECONDS + 1 })).toThrow(
      /between 1 and 600/i,
    );
    expect(() => issue({ ttlSeconds: 0 })).toThrow(/between 1 and 600/i);
    expect(() => issue({ ttlSeconds: 1.5 })).toThrow(/between 1 and 600/i);
  });

  it('hashes the same plaintext to different values for every row', () => {
    const first = issue();
    const second = issue({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' });

    expect(first.codeSalt).not.toBe(second.codeSalt);
    expect(first.codeHash).not.toBe(second.codeHash);
    expect(first.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyVerificationCode('483920', first.codeSalt, first.codeHash)).toBe(true);
    expect(verifyVerificationCode('000000', first.codeSalt, first.codeHash)).toBe(false);
  });

  it('never exposes the plaintext on the aggregate', () => {
    const code = issue();

    expect(JSON.stringify(code)).not.toContain('483920');
    expect(Object.values(code)).not.toContain('483920');
  });

  it('generates uniform six-digit codes', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('verification-code-issued event builder', () => {
  it('is deterministic and anchors the BR-03 clock at issuedAt', () => {
    const account = registered();
    const props = {
      eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      correlationId: 'corr-1',
      account: { id: account.id, email: account.email, language: account.language },
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
      accountId: account.id,
      email: 'user@example.com',
      code: '483920',
      purpose: 'sign_up',
      language: 'ar',
      issuedAt: '2026-10-24T10:00:00.000Z',
      expiresAt: '2026-10-24T10:10:00.000Z',
    });
  });

  it('shares the TTL guard with the aggregate', () => {
    const account = registered();

    expect(() =>
      buildVerificationCodeIssued({
        eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        correlationId: 'corr-1',
        account: { id: account.id, email: account.email, language: account.language },
        code: '483920',
        purpose: 'sign_up',
        ttlSeconds: 601,
        issuedAt: NOW,
      }),
    ).toThrow(/between 1 and 600/i);
  });
});
