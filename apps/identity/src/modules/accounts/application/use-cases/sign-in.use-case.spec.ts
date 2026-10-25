import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  type SignInResponseDto,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { SignInUseCase } from './sign-in.use-case.js';
import { AuthError } from '../auth-error.js';
import type { AccountRepositoryPort } from '../ports/account.repository.port.js';
import type { SignInLockoutRepositoryPort } from '../ports/sign-in-lockout.repository.port.js';
import type { PasswordHasherPort } from '../ports/password-hasher.port.js';
import type { SessionIssuer } from '../services/session.issuer.js';
import type { VerificationRatePolicy } from '../services/verification-rate.policy.js';
import { Account } from '../../domain/account.js';
import {
  SIGN_IN_LOCK_SECONDS,
  SIGN_IN_LOCK_THRESHOLD,
  SignInLockout,
} from '../../domain/sign-in-lockout.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const PASSWORD = 'Str0ng!Pass';
const TOKENS = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer' as const,
  accessExpiresIn: TOKEN_DEFAULTS.accessTtlSeconds,
  refreshExpiresIn: TOKEN_DEFAULTS.refreshTtlSeconds,
};

function account(
  status: 'pending' | 'active' | 'disabled' = 'active',
  passwordHash = 'stored-hash',
): Account {
  return Account.restore({
    id: 'account-1',
    email: 'user@example.com',
    language: 'ar',
    status,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    passwordHash,
    passwordUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
    emailVerifiedAt:
      status === 'active' ? new Date('2026-10-01T00:00:00.000Z') : null,
  });
}

interface Harness {
  useCase: SignInUseCase;
  calls: string[];
  transaction: TransactionContext;
  savedLockouts(): SignInLockout[];
  issue: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  hash: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  givenAccount(value: Account | null): void;
  givenLockout(value: SignInLockout | null): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundAccount: Account | null = account();
  let savedLockout: SignInLockout | null = null;
  const lockoutsWritten: SignInLockout[] = [];

  const accounts: AccountRepositoryPort = {
    save: async () => {},
    update: async () => {},
    findByEmail: async () => foundAccount,
    findById: async () => foundAccount,
    findByEmailForUpdate: async (received, email) => {
      expect(received).toBe(transaction);
      calls.push(`lock-account:${email}`);
      return foundAccount;
    },
    findByIdForUpdate: async () => foundAccount,
  };
  const lockouts: SignInLockoutRepositoryPort = {
    find: async (email) => {
      calls.push(`find-lockout:${email}`);
      return savedLockout;
    },
    findForUpdate: async (received, email) => {
      expect(received).toBe(transaction);
      calls.push('lock-lockout');
      return savedLockout?.email === email ? savedLockout : null;
    },
    save: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('save-lockout');
      lockoutsWritten.push(value);
    },
  };
  const verify = vi.fn(async (plaintext: string, hash: string) => {
    calls.push(`verify:${plaintext}`);
    return hash === 'stored-hash' && plaintext === PASSWORD;
  });
  const hash = vi.fn(async () => {
    calls.push('hash-dummy');
    return 'dummy-hash';
  });
  const passwords: PasswordHasherPort = { hash, verify };
  const issue = vi.fn(async () => ({
    tokens: TOKENS,
    session: {} as never,
    refreshToken: {} as never,
    accessExpiresAt: new Date(NOW.getTime() + 900_000),
  }));
  const sessions = { issue } as unknown as SessionIssuer;
  const evaluate = vi.fn(async () => ({
    allowed: false,
    secondsRemaining: 90,
  }));
  const ratePolicy = { evaluate } as unknown as VerificationRatePolicy;
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
    useCase: new SignInUseCase(
      unitOfWork,
      accounts,
      passwords,
      lockouts,
      sessions,
      ratePolicy,
    ),
    calls,
    transaction,
    savedLockouts: () => lockoutsWritten,
    issue,
    verify,
    hash,
    evaluate,
    givenAccount: (value) => {
      foundAccount = value;
    },
    givenLockout: (value) => {
      savedLockout = value;
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

function command(overrides: Partial<{ email: string; password: string }> = {}) {
  return {
    email: ' User@Example.COM ',
    password: PASSWORD,
    deviceId: 'device-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('SignInUseCase (BR-04, BR-05, BR-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a token pair for a verified account and resets the counter', async () => {
    const h = harness();
    h.givenLockout(new SignInLockout('user@example.com', 3, null, NOW));

    const result: SignInResponseDto = await h.useCase.execute(command());

    expect(result).toEqual({
      verificationRequired: false,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 0,
      tokens: TOKENS,
    });
    expect(h.verify).toHaveBeenCalledWith(PASSWORD, 'stored-hash');
    expect(h.issue).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ id: 'account-1' }),
      NOW,
    );
    expect(h.savedLockouts()).toHaveLength(1);
    expect(h.savedLockouts()[0].failedCount).toBe(0);
    expect(h.savedLockouts()[0].lockedUntil).toBeNull();
  });

  it('returns verificationRequired and no tokens for a pending account', async () => {
    const h = harness();
    h.givenAccount(account('pending'));

    const result = await h.useCase.execute(command());

    expect(result).toEqual({
      verificationRequired: true,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 90,
      tokens: null,
    });
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.evaluate).toHaveBeenCalledWith(
      'user@example.com',
      'sign_up',
      NOW,
    );
  });

  it('answers an unknown address and a wrong password with the same code', async () => {
    const unknown = harness();
    unknown.givenAccount(null);
    const unknownError = await errorOf(unknown.useCase.execute(command()));

    const wrong = harness();
    const wrongError = await errorOf(
      wrong.useCase.execute(command({ password: 'Wr0ng!Pass' })),
    );

    expect(unknownError.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(wrongError.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(unknown.savedLockouts()[0].failedCount).toBe(1);
    expect(wrong.savedLockouts()[0].failedCount).toBe(1);
    // The unknown address still pays for one bcrypt comparison.
    expect(unknown.hash).toHaveBeenCalledOnce();
    expect(unknown.verify).toHaveBeenCalledWith(
      PASSWORD,
      'dummy-hash',
    );
  });

  it('hashes the dummy password only once across probes', async () => {
    const h = harness();
    h.givenAccount(null);

    await errorOf(h.useCase.execute(command()));
    await errorOf(h.useCase.execute(command({ email: 'other@example.com' })));

    expect(h.hash).toHaveBeenCalledOnce();
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it('locks after the configured number of failures with a retry hint', async () => {
    const h = harness();
    h.givenLockout(
      new SignInLockout(
        'user@example.com',
        SIGN_IN_LOCK_THRESHOLD - 1,
        null,
        NOW,
      ),
    );

    const error = await errorOf(
      h.useCase.execute(command({ password: 'Wr0ng!Pass' })),
    );

    expect(error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(error.retryAfterSeconds).toBe(SIGN_IN_LOCK_SECONDS);
    expect(h.savedLockouts()[0].lockedUntil).toEqual(
      new Date(NOW.getTime() + SIGN_IN_LOCK_SECONDS * 1000),
    );
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('refuses a locked account before opening a transaction', async () => {
    const h = harness();
    h.givenLockout(
      new SignInLockout(
        'user@example.com',
        SIGN_IN_LOCK_THRESHOLD,
        new Date(NOW.getTime() + 60_000),
        NOW,
      ),
    );

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(error.retryAfterSeconds).toBe(60);
    expect(h.calls).toEqual(['find-lockout:user@example.com']);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('checks the password before revealing that an account is disabled', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    expect(
      (await errorOf(h.useCase.execute(command({ password: 'Wr0ng!Pass' }))))
        .code,
    ).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(
      (await errorOf(h.useCase.execute(command()))).code,
    ).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('does not issue a session when the stored hash is missing', async () => {
    const h = harness();
    h.givenAccount(account('active', ''));

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(h.issue).not.toHaveBeenCalled();
  });
});
