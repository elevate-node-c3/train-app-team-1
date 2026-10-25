import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  type EmailVerifiedEvent,
  type VerificationCodePurpose,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { VerifyEmailUseCase } from './verify-email.use-case.js';
import { AuthError } from '../auth-error.js';
import type { AccountRepositoryPort } from '../ports/account.repository.port.js';
import type { VerificationCodeRepositoryPort } from '../ports/verification-code.repository.port.js';
import type { SessionIssuer } from '../services/session.issuer.js';
import { Account } from '../../domain/account.js';
import { VerificationCode } from '../../domain/verification-code.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const CODE = '123456';
const TOKENS = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer' as const,
  accessExpiresIn: TOKEN_DEFAULTS.accessTtlSeconds,
  refreshExpiresIn: TOKEN_DEFAULTS.refreshTtlSeconds,
};

function account(status: 'pending' | 'active' | 'disabled' = 'pending'): Account {
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

function code(
  overrides: Partial<Parameters<typeof VerificationCode.restore>[0]> = {},
): VerificationCode {
  return VerificationCode.restore({
    id: 'code-1',
    accountId: 'account-1',
    purpose: 'sign_up',
    codeHash: '',
    codeSalt: '',
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 600_000),
    ...overrides,
  });
}

function liveCode(): VerificationCode {
  return VerificationCode.issue({
    id: 'code-1',
    accountId: 'account-1',
    purpose: 'sign_up',
    code: CODE,
    ttlSeconds: 600,
    issuedAt: NOW,
  });
}

interface Harness {
  useCase: VerifyEmailUseCase;
  calls: string[];
  transaction: TransactionContext;
  events(): EmailVerifiedEvent[];
  updatedAccount(): Account | undefined;
  updatedCodes(): VerificationCode[];
  issue: ReturnType<typeof vi.fn>;
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
  const events: EmailVerifiedEvent[] = [];

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
      expect(purpose).toBe('sign_up');
      expect(options).toEqual({ forUpdate: true });
      calls.push('find-code');
      return foundCode;
    },
    consumeLive: async () => {},
  };
  const issue = vi.fn(async () => ({
    tokens: TOKENS,
    session: {} as never,
    refreshToken: {} as never,
    accessExpiresAt: new Date(NOW.getTime() + 900_000),
  }));
  const sessions = { issue } as unknown as SessionIssuer;
  const outbox: OutboxPort = {
    append: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('outbox');
      events.push(value as EmailVerifiedEvent);
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
    useCase: new VerifyEmailUseCase(
      unitOfWork,
      accounts,
      codes,
      sessions,
      outbox,
    ),
    calls,
    transaction,
    events: () => events,
    updatedAccount: () => updatedAccountValue,
    updatedCodes: () => updatedCodeValues,
    issue,
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

function command() {
  return {
    email: 'user@example.com',
    code: CODE,
    deviceId: 'device-1',
    correlationId: 'corr-1',
  };
}

describe('VerifyEmailUseCase (BR-03, BR-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('consumes the code, activates the account and starts a session atomically', async () => {
    const h = harness();

    const result = await h.useCase.execute(command());

    expect(result).toEqual({
      ...TOKENS,
      accountId: 'account-1',
      maskedEmail: 'u***@example.com',
    });
    expect(h.calls).toEqual([
      'begin',
      'lock-account:user@example.com',
      'find-code',
      'code-update',
      'account-update',
      'outbox',
      'commit',
    ]);
    expect(h.updatedCodes()[0].consumedAt).toEqual(NOW);
    expect(h.updatedAccount()?.status).toBe('active');
    expect(h.updatedAccount()?.emailVerifiedAt).toEqual(NOW);
    expect(h.issue).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ id: 'account-1', status: 'active' }),
      NOW,
    );
  });

  it('emits email.verified with the account and correlation', async () => {
    const h = harness();

    await h.useCase.execute(command());

    expect(h.events()).toHaveLength(1);
    expect(h.events()[0]).toMatchObject({
      type: 'identity.email.verified',
      version: 1,
      producer: 'identity',
      correlationId: 'corr-1',
      occurredAt: NOW.toISOString(),
      payload: {
        accountId: 'account-1',
        email: 'user@example.com',
        verifiedAt: NOW.toISOString(),
      },
    });
  });

  it('commits the attempt counter before rejecting a wrong code (BR-05)', async () => {
    const h = harness();

    const error = await errorOf(
      h.useCase.execute({ ...command(), code: '000000' }),
    );

    expect(error.code).toBe(ErrorCode.INVALID_VERIFICATION_CODE);
    expect(h.calls).toEqual([
      'begin',
      'lock-account:user@example.com',
      'find-code',
      'code-update',
      'commit',
    ]);
    expect(h.updatedCodes()).toHaveLength(1);
    expect(h.updatedCodes()[0].attempts).toBe(1);
    expect(h.updatedAccount()).toBeUndefined();
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.events()).toEqual([]);
  });

  it('reports an expired code distinctly from a wrong one', async () => {
    const h = harness();
    h.givenCode(
      code({
        codeHash: '00',
        codeSalt: '00',
        expiresAt: new Date(NOW.getTime() - 1),
      }),
    );

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.VERIFICATION_CODE_EXPIRED);
    expect(h.updatedCodes()).toEqual([]);
  });

  it('rejects a consumed code and an exhausted code without another write', async () => {
    const consumed = harness();
    consumed.givenCode(code({ consumedAt: NOW }));
    expect((await errorOf(consumed.useCase.execute(command()))).code).toBe(
      ErrorCode.INVALID_VERIFICATION_CODE,
    );
    expect(consumed.updatedCodes()).toEqual([]);

    const exhausted = harness();
    const live = liveCode().recordFailure();
    const maxed = Array.from({ length: 4 }).reduce(
      (current) => current.recordFailure(),
      live,
    );
    exhausted.givenCode(maxed);
    expect((await errorOf(exhausted.useCase.execute(command()))).code).toBe(
      ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED,
    );
    expect(exhausted.updatedCodes()).toEqual([]);
  });

  it('answers an unknown account exactly like a wrong code', async () => {
    const h = harness();
    h.givenAccount(null);

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.INVALID_VERIFICATION_CODE);
    expect(h.calls).toEqual([
      'begin',
      'lock-account:user@example.com',
      'commit',
    ]);
  });

  it('refuses a disabled account even with a valid code (BR-09)', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    const error = await errorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(h.updatedCodes()).toEqual([]);
    expect(h.issue).not.toHaveBeenCalled();
  });
});
