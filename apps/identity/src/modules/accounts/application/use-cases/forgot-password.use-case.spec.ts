import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { ForgotPasswordUseCase } from './forgot-password.use-case.js';
import type { AccountRepositoryPort } from '../ports/account.repository.port.js';
import type { VerificationCodeIssuer } from '../services/verification-code.issuer.js';
import type { VerificationRatePolicy } from '../services/verification-rate.policy.js';
import { Account } from '../../domain/account.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');

function account(status: 'pending' | 'active' | 'disabled' = 'active'): Account {
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
  useCase: ForgotPasswordUseCase;
  calls: string[];
  transaction: TransactionContext;
  prepare: ReturnType<typeof vi.fn>;
  issue: ReturnType<typeof vi.fn>;
  recordRequest: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
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
  const prepared = {
    code: {},
    plaintext: '123456',
    ttlSeconds: 600,
  };
  const prepare = vi.fn(() => {
    calls.push('prepare');
    return prepared;
  });
  const issue = vi.fn(async () => {
    calls.push('issue');
  });
  const recordRequest = vi.fn(async () => {
    calls.push('record-request');
  });
  const codes = {
    prepare,
    issue,
    recordRequest,
  } as unknown as VerificationCodeIssuer;
  const evaluate = vi.fn(async () => {
    calls.push('evaluate');
    return decision;
  });
  const ratePolicy = {
    evaluate,
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
    useCase: new ForgotPasswordUseCase(
      unitOfWork,
      accounts,
      codes,
      ratePolicy,
    ),
    calls,
    transaction,
    prepare,
    issue,
    recordRequest,
    evaluate,
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

function command() {
  return {
    email: ' User@Example.COM ',
    correlationId: 'corr-1',
  };
}

describe('ForgotPasswordUseCase (BR-08, BR-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a reset code for an eligible account', async () => {
    const h = harness();

    await expect(h.useCase.execute(command())).resolves.toEqual({
      secondsRemaining: 120,
    });

    expect(h.evaluate).toHaveBeenCalledWith(
      'user@example.com',
      'password_reset',
      NOW,
    );
    expect(h.calls).toEqual([
      'evaluate',
      'find:user@example.com',
      'prepare',
      'begin',
      'lock-account:user@example.com',
      'issue',
      'commit',
    ]);
    expect(h.prepare).toHaveBeenCalledWith(
      'account-1',
      'password_reset',
      NOW,
    );
    expect(h.issue).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({
        account: expect.objectContaining({ id: 'account-1' }),
        purpose: 'password_reset' satisfies VerificationCodePurpose,
        prepared: expect.objectContaining({ plaintext: '123456' }),
        correlationId: 'corr-1',
        now: NOW,
      }),
    );
    expect(h.recordRequest).not.toHaveBeenCalled();
  });

  it('records the counter for an unknown address without sending mail', async () => {
    const h = harness();
    h.givenAccount(null);

    await expect(h.useCase.execute(command())).resolves.toEqual({
      secondsRemaining: 120,
    });

    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.recordRequest).toHaveBeenCalledWith(h.transaction, {
      email: 'user@example.com',
      accountId: null,
      purpose: 'password_reset',
      now: NOW,
    });
  });

  it('gives an unknown address and an eligible account the same answer', async () => {
    const known = harness();
    const unknown = harness();
    unknown.givenAccount(null);

    const knownResult = await known.useCase.execute(command());
    const unknownResult = await unknown.useCase.execute(command());

    expect(Object.keys(knownResult)).toEqual(Object.keys(unknownResult));
    expect(knownResult).toEqual(unknownResult);
  });

  it('records the counter but sends nothing for a disabled account', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    await h.useCase.execute(command());

    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.recordRequest).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ accountId: 'account-1' }),
    );
  });

  it('counts an unknown address that raced to a disabled state', async () => {
    const h = harness();
    h.givenLocked(account('disabled'));

    await h.useCase.execute(command());

    expect(h.issue).not.toHaveBeenCalled();
    expect(h.recordRequest).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ accountId: 'account-1' }),
    );
  });

  it('returns the retry interval without touching the account on rate limit', async () => {
    const h = harness();
    h.givenRateDecision(false, 90);

    await expect(h.useCase.execute(command())).resolves.toEqual({
      secondsRemaining: 90,
    });

    expect(h.calls).toEqual(['evaluate']);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.recordRequest).not.toHaveBeenCalled();
  });
});
