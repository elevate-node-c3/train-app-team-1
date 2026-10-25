import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  type PasswordResetEvent,
  type SessionRevokedEvent,
  type VerificationCodePurpose,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { ResetPasswordUseCase } from './reset-password.use-case.js';
import { AuthError } from '../auth-error.js';
import type { AccountRepositoryPort } from '../ports/account.repository.port.js';
import type { DeviceCredentialRepositoryPort } from '../ports/device-credential.repository.port.js';
import type { PasswordHasherPort } from '../ports/password-hasher.port.js';
import type { RefreshTokenRepositoryPort } from '../ports/refresh-token.repository.port.js';
import type { SessionRepositoryPort } from '../ports/session.repository.port.js';
import type { VerificationCodeRepositoryPort } from '../ports/verification-code.repository.port.js';
import { Account } from '../../domain/account.js';
import { VerificationCode } from '../../domain/verification-code.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const CODE = '123456';
const CURRENT_PASSWORD = 'Current!Pass1';
const NEW_PASSWORD = 'N3w!Passw0rd';

function account(status: 'active' | 'disabled' = 'active'): Account {
  return Account.restore({
    id: 'account-1',
    email: 'user@example.com',
    language: 'ar',
    status,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    passwordHash: 'current-hash',
    passwordUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
}

function liveCode(): VerificationCode {
  return VerificationCode.issue({
    id: 'code-1',
    accountId: 'account-1',
    purpose: 'password_reset',
    code: CODE,
    ttlSeconds: 600,
    issuedAt: NOW,
  });
}

interface Harness {
  useCase: ResetPasswordUseCase;
  calls: string[];
  transaction: TransactionContext;
  events(): (PasswordResetEvent | SessionRevokedEvent)[];
  updatedAccount(): Account | undefined;
  updatedCodes(): VerificationCode[];
  hash: ReturnType<typeof vi.fn>;
  givenAccount(value: Account | null): void;
  givenCode(value: VerificationCode | null): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundAccount: Account | null = account();
  let foundCode: VerificationCode | null = liveCode();
  let updatedAccountValue: Account | undefined;
  const updatedCodeValues: VerificationCode[] = [];
  const events: (PasswordResetEvent | SessionRevokedEvent)[] = [];

  const accounts: AccountRepositoryPort = {
    save: async () => {},
    update: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('account-update');
      updatedAccountValue = value;
    },
    findByEmail: async () => foundAccount,
    findById: async () => foundAccount,
    findByEmailForUpdate: async (received, email) => {
      expect(received).toBe(transaction);
      calls.push(`lock-account:${email}`);
      return foundAccount;
    },
    findByIdForUpdate: async () => foundAccount,
  };
  const codes: VerificationCodeRepositoryPort = {
    save: async () => {},
    update: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('code-update');
      updatedCodeValues.push(value);
    },
    findLatestLive: async (
      received,
      accountId,
      purpose: VerificationCodePurpose,
      options,
    ) => {
      expect(received).toBe(transaction);
      expect(accountId).toBe('account-1');
      expect(purpose).toBe('password_reset');
      expect(options).toEqual({ forUpdate: true });
      calls.push('find-code');
      return foundCode;
    },
    consumeLive: async () => {},
  };
  const hash = vi.fn(async (plaintext: string) => {
    calls.push(`hash:${plaintext}`);
    return `${plaintext}-hash`;
  });
  const verify = vi.fn(
    async (plaintext: string, hashValue: string) =>
      hashValue === 'current-hash' && plaintext === CURRENT_PASSWORD,
  );
  const passwords: PasswordHasherPort = { hash, verify };
  const sessions: SessionRepositoryPort = {
    save: async () => {},
    update: async () => {},
    findById: async () => null,
    findByIdForUpdate: async () => null,
    revokeByAccount: async (received, id, reason) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-sessions:${id}:${reason}`);
      return ['session-1', 'session-2'];
    },
  };
  const refreshTokens: RefreshTokenRepositoryPort = {
    save: async () => {},
    update: async () => {},
    findByHash: async () => null,
    findByHashForUpdate: async () => null,
    revokeBySession: async () => {},
    revokeByAccount: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-tokens:${id}`);
    },
  };
  const deviceCredentials: DeviceCredentialRepositoryPort = {
    revokeBySession: async () => {},
    revokeByAccount: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-devices:${id}`);
    },
  };
  const outbox: OutboxPort = {
    append: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push(`outbox:${value.type}`);
      events.push(value as PasswordResetEvent | SessionRevokedEvent);
    },
  };
  const unitOfWork: UnitOfWorkPort = {
    withTransaction: async <T>(
      work: (ctx: TransactionContext) => Promise<T>,
    ): Promise<T> => {
      calls.push('begin');
      const result = await work(transaction);
      calls.push('commit');
      return result;
    },
  };

  return {
    useCase: new ResetPasswordUseCase(
      unitOfWork,
      accounts,
      codes,
      passwords,
      sessions,
      refreshTokens,
      deviceCredentials,
      outbox,
    ),
    calls,
    transaction,
    events: () => events,
    updatedAccount: () => updatedAccountValue,
    updatedCodes: () => updatedCodeValues,
    hash,
    givenAccount: (value) => {
      foundAccount = value;
    },
    givenCode: (value) => {
      foundCode = value;
    },
  };
}

async function errorOf(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected the use case to reject');
}

function command(overrides: Partial<{ newPassword: string; code: string }> = {}) {
  return {
    email: ' User@Example.COM ',
    code: CODE,
    newPassword: NEW_PASSWORD,
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('ResetPasswordUseCase (BR-07, BR-08)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('changes the password and revokes every session in one transaction', async () => {
    const h = harness();

    await expect(h.useCase.execute(command())).resolves.toEqual({ reset: true });

    expect(h.calls).toEqual([
      `hash:${NEW_PASSWORD}`,
      'begin',
      'lock-account:user@example.com',
      'find-code',
      'code-update',
      'account-update',
      'revoke-sessions:account-1:password_reset',
      'revoke-tokens:account-1',
      'revoke-devices:account-1',
      'outbox:identity.password.reset',
      'outbox:identity.session.revoked',
      'commit',
    ]);
    expect(h.updatedCodes()[0].consumedAt).toEqual(NOW);
    expect(h.updatedAccount()?.passwordHash).toBe(`${NEW_PASSWORD}-hash`);
    expect(h.updatedAccount()?.passwordUpdatedAt).toEqual(NOW);
  });

  it('publishes a password reset and one account-wide revocation', async () => {
    const h = harness();

    await h.useCase.execute(command());

    expect(h.events()[0]).toMatchObject({
      type: 'identity.password.reset',
      correlationId: 'corr-1',
      payload: { accountId: 'account-1', resetAt: NOW.toISOString() },
    });
    expect(h.events()[1]).toMatchObject({
      type: 'identity.session.revoked',
      correlationId: 'corr-1',
      payload: {
        accountId: 'account-1',
        sessionId: 'session-1',
        jti: '',
        reason: 'password_reset',
        allSessions: true,
        revokedAt: NOW.toISOString(),
        expiresAt: new Date(
          NOW.getTime() + TOKEN_DEFAULTS.accessTtlSeconds * 1000,
        ).toISOString(),
      },
    });
  });

  it('rejects a weak password before hashing or opening a transaction', async () => {
    const h = harness();

    const error = await errorOf(
      h.useCase.execute(command({ newPassword: 'short' })),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(h.hash).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('commits the failed attempt before rejecting a wrong code (BR-05)', async () => {
    const h = harness();

    const error = await errorOf(
      h.useCase.execute(command({ code: '000000' })),
    );

    expect(error.code).toBe(ErrorCode.PASSWORD_RESET_INVALID);
    expect(h.updatedCodes()).toHaveLength(1);
    expect(h.updatedCodes()[0].attempts).toBe(1);
    expect(h.calls).toEqual([
      `hash:${NEW_PASSWORD}`,
      'begin',
      'lock-account:user@example.com',
      'find-code',
      'code-update',
      'commit',
    ]);
    expect(h.updatedAccount()).toBeUndefined();
    expect(h.events()).toEqual([]);
  });

  it('treats expired, consumed and exhausted codes the same way', async () => {
    const cases = [
      VerificationCode.restore({
        id: 'code-1',
        accountId: 'account-1',
        purpose: 'password_reset',
        codeHash: '00',
        codeSalt: '00',
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() - 1),
      }),
      liveCode().consume(NOW),
      Array.from({ length: 5 }).reduce<VerificationCode>(
        (current) => current.recordFailure(),
        liveCode(),
      ),
      null,
    ];

    for (const value of cases) {
      const h = harness();
      h.givenCode(value);

      const error = await errorOf(h.useCase.execute(command()));

      expect(error.code).toBe(ErrorCode.PASSWORD_RESET_INVALID);
      expect(h.updatedAccount()).toBeUndefined();
      expect(h.events()).toEqual([]);
    }
  });

  it('refuses to set the current password again', async () => {
    const h = harness();

    const error = await errorOf(
      h.useCase.execute(command({ newPassword: CURRENT_PASSWORD })),
    );

    expect(error.code).toBe(ErrorCode.PASSWORD_REUSE);
    expect(h.updatedCodes()).toEqual([]);
    expect(h.updatedAccount()).toBeUndefined();
    expect(h.events()).toEqual([]);
  });

  it('uses one indistinguishable answer for an unknown address', async () => {
    const h = harness();
    h.givenAccount(null);

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.PASSWORD_RESET_INVALID);
    expect(h.updatedCodes()).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  it('refuses a disabled account', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    expect((await errorOf(h.useCase.execute(command()))).code).toBe(
      ErrorCode.ACCOUNT_DISABLED,
    );
    expect(h.updatedAccount()).toBeUndefined();
  });
});
