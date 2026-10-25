import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { ResendVerificationUseCase } from './resend-verification.use-case.js';
import { AuthError } from '../auth-error.js';
import type { AccountRepositoryPort } from '../ports/account.repository.port.js';
import type { VerificationCodeIssuer } from '../services/verification-code.issuer.js';
import type { VerificationRatePolicy } from '../services/verification-rate.policy.js';
import { Account } from '../../domain/account.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');

function account(
  status: 'pending' | 'active' | 'disabled' = 'pending',
): Account {
  return Account.restore({
    id: 'account-1',
    email: 'user@example.com',
    language: 'ar',
    status,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    passwordHash: 'hash',
    passwordUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
}

interface Harness {
  useCase: ResendVerificationUseCase;
  calls: string[];
  transaction: TransactionContext;
  issue: ReturnType<typeof vi.fn>;
  givenAccount(value: Account | null): void;
  givenLocked(value: Account | null): void;
  givenRateDecision(allowed: boolean, secondsRemaining: number): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundAccount: Account | null = account();
  let lockedAccount: Account | null = account();
  let decision = { allowed: true, secondsRemaining: 0 };

  const accounts: AccountRepositoryPort = {
    save: async () => {},
    update: async () => {},
    findByEmail: async (email) => {
      calls.push(`find:${email}`);
      return foundAccount;
    },
    findById: async () => foundAccount,
    findByEmailForUpdate: async (received, email) => {
      expect(received).toBe(transaction);
      calls.push(`lock-account:${email}`);
      return lockedAccount;
    },
    findByIdForUpdate: async () => lockedAccount,
  };
  const issue = vi.fn(async () => {
    calls.push('issue');
  });
  const codes = {
    prepare: vi.fn(() => ({ code: {}, plaintext: '123456', ttlSeconds: 600 })),
    issue,
  } as unknown as VerificationCodeIssuer;
  const ratePolicy = {
    evaluate: vi.fn(async () => {
      calls.push('evaluate');
      return decision;
    }),
    nextAllowedSeconds: () => 120,
  } as unknown as VerificationRatePolicy;
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
    useCase: new ResendVerificationUseCase(
      unitOfWork,
      accounts,
      codes,
      ratePolicy,
    ),
    calls,
    transaction,
    issue,
    givenAccount: (value) => {
      foundAccount = value;
    },
    givenLocked: (value) => {
      lockedAccount = value;
    },
    givenRateDecision: (allowed, secondsRemaining) => {
      decision = { allowed, secondsRemaining };
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

function command() {
  return { email: 'user@example.com', correlationId: 'corr-1' };
}

describe('ResendVerificationUseCase (BR-03, BR-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a fresh code for a pending account', async () => {
    const h = harness();

    await expect(h.useCase.execute(command())).resolves.toEqual({
      maskedEmail: 'u***@example.com',
      secondsRemaining: 120,
    });

    expect(h.calls).toEqual([
      'find:user@example.com',
      'evaluate',
      'begin',
      'lock-account:user@example.com',
      'issue',
      'commit',
    ]);
    expect(h.issue).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({
        account: expect.objectContaining({ id: 'account-1' }),
        purpose: 'sign_up',
        correlationId: 'corr-1',
        now: NOW,
      }),
    );
  });

  it('returns the durable retry window instead of issuing', async () => {
    const h = harness();
    h.givenRateDecision(false, 90);

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.RESEND_TOO_SOON);
    expect(error.retryAfterSeconds).toBe(90);
    expect(h.calls).toEqual(['find:user@example.com', 'evaluate']);
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('refuses to resend for an address that no longer exists', async () => {
    const h = harness();
    h.givenAccount(null);

    expect((await errorOf(h.useCase.execute(command()))).code).toBe(
      ErrorCode.RESOURCE_NOT_FOUND,
    );
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('refuses to resend for a verified or disabled account', async () => {
    const verified = harness();
    verified.givenAccount(account('active'));
    expect((await errorOf(verified.useCase.execute(command()))).code).toBe(
      ErrorCode.EMAIL_ALREADY_REGISTERED,
    );

    const disabled = harness();
    disabled.givenAccount(account('disabled'));
    expect((await errorOf(disabled.useCase.execute(command()))).code).toBe(
      ErrorCode.ACCOUNT_DISABLED,
    );
  });

  it('rechecks state under the row lock before issuing', async () => {
    const h = harness();
    h.givenLocked(account('active'));

    expect((await errorOf(h.useCase.execute(command()))).code).toBe(
      ErrorCode.EMAIL_ALREADY_REGISTERED,
    );
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('refuses when the account disappeared between the read and the lock', async () => {
    const h = harness();
    h.givenLocked(null);

    expect((await errorOf(h.useCase.execute(command()))).code).toBe(
      ErrorCode.RESOURCE_NOT_FOUND,
    );
    expect(h.issue).not.toHaveBeenCalled();
  });
});
