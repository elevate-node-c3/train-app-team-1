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
import {
  PasswordsService,
  type ForgotPasswordCommand,
  type ResetPasswordCommand,
} from './passwords.service.js';
import { AuthError } from '../auth-error.js';
import { BcryptPasswordHasher } from '../bcrypt-password.hasher.js';
import { AccountEntity } from '../entities/account.entity.js';
import { VerificationCodeEntity } from '../entities/verification-code.entity.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { DeviceCredentialRepository } from '../repositories/device-credential.repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { VerificationCodeRepository } from '../repositories/verification-code.repository.js';
import {
  generateVerificationCodeSalt,
  hashVerificationCode,
} from '../verification-code.hashing.js';
import { VerificationCodeIssuer } from '../verification-code.issuer.js';
import { VerificationRatePolicy } from '../verification-rate.policy.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const CODE = '123456';
const CURRENT_PASSWORD = 'Current!Pass1';
const NEW_PASSWORD = 'N3w!Passw0rd';

function account(status: 'active' | 'disabled' = 'active'): AccountEntity {
  const row = new AccountEntity();
  row.id = 'account-1';
  row.email = 'user@example.com';
  row.language = 'ar';
  row.status = status;
  row.createdAt = new Date('2026-10-01T00:00:00.000Z');
  row.passwordHash = 'current-hash';
  row.passwordUpdatedAt = new Date('2026-10-01T00:00:00.000Z');
  row.emailVerifiedAt = new Date('2026-10-01T00:00:00.000Z');
  row.bookable = false;
  row.roles = [];
  return row;
}

function code(
  overrides: Partial<VerificationCodeEntity> = {},
): VerificationCodeEntity {
  const salt = generateVerificationCodeSalt();
  const row = new VerificationCodeEntity();
  row.id = 'code-1';
  row.accountId = 'account-1';
  row.purpose = 'password_reset';
  row.codeHash = hashVerificationCode(CODE, salt);
  row.codeSalt = salt;
  row.issuedAt = NOW;
  row.expiresAt = new Date(NOW.getTime() + 600_000);
  row.consumedAt = null;
  row.attempts = 0;
  row.maxAttempts = 5;
  return Object.assign(row, overrides);
}

interface Harness {
  service: PasswordsService;
  calls: string[];
  transaction: TransactionContext;
  events(): (PasswordResetEvent | SessionRevokedEvent)[];
  updatedAccount(): AccountEntity | undefined;
  updatedCodes(): VerificationCodeEntity[];
  prepare: ReturnType<typeof vi.fn>;
  issue: ReturnType<typeof vi.fn>;
  recordRequest: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  hash: ReturnType<typeof vi.fn>;
  givenAccount(value: AccountEntity | null): void;
  givenLocked(value: AccountEntity | null): void;
  givenCode(value: VerificationCodeEntity | null): void;
  givenRateDecision(allowed: boolean, secondsRemaining: number): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundAccount: AccountEntity | null = account();
  let lockedAccount: AccountEntity | null = account();
  let foundCode: VerificationCodeEntity | null = code();
  let decision = { allowed: true, secondsRemaining: 0 };
  let updatedAccountValue: AccountEntity | undefined;
  const updatedCodeValues: VerificationCodeEntity[] = [];
  const events: (PasswordResetEvent | SessionRevokedEvent)[] = [];

  const accounts = {
    save: async () => {},
    update: async (received: TransactionContext, value: AccountEntity) => {
      expect(received).toBe(transaction);
      calls.push('account-update');
      updatedAccountValue = value;
    },
    findByEmail: async (email: string) => {
      calls.push(`find:${email}`);
      return foundAccount;
    },
    findById: async () => foundAccount,
    findByEmailForUpdate: async (
      received: TransactionContext,
      email: string,
    ) => {
      expect(received).toBe(transaction);
      calls.push(`lock-account:${email}`);
      return lockedAccount;
    },
    findByIdForUpdate: async () => lockedAccount,
  } as unknown as AccountRepository;

  const codes = {
    save: async () => {},
    update: async (
      received: TransactionContext,
      value: VerificationCodeEntity,
    ) => {
      expect(received).toBe(transaction);
      calls.push('code-update');
      updatedCodeValues.push(value);
    },
    findLatestLive: async (
      received: TransactionContext,
      accountId: string,
      purpose: VerificationCodePurpose,
      options: { forUpdate?: boolean } = {},
    ) => {
      expect(received).toBe(transaction);
      expect(accountId).toBe('account-1');
      expect(purpose).toBe('password_reset');
      expect(options).toEqual({ forUpdate: true });
      calls.push('find-code');
      return foundCode;
    },
    consumeLive: async () => {},
  } as unknown as VerificationCodeRepository;

  const hash = vi.fn(async (plaintext: string) => {
    calls.push(`hash:${plaintext}`);
    return `${plaintext}-hash`;
  });
  const verify = vi.fn(
    async (plaintext: string, hashValue: string) =>
      hashValue === 'current-hash' && plaintext === CURRENT_PASSWORD,
  );
  const passwords = { hash, verify } as unknown as BcryptPasswordHasher;

  const sessions = {
    save: async () => {},
    update: async () => {},
    findById: async () => null,
    findByIdForUpdate: async () => null,
    revokeByAccount: async (
      received: TransactionContext,
      id: string,
      reason: string,
    ) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-sessions:${id}:${reason}`);
      return ['session-1', 'session-2'];
    },
  } as unknown as SessionRepository;

  const refreshTokens = {
    save: async () => {},
    update: async () => {},
    findByHash: async () => null,
    findByHashForUpdate: async () => null,
    revokeBySession: async () => {},
    revokeByAccount: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-tokens:${id}`);
    },
  } as unknown as RefreshTokenRepository;

  const deviceCredentials = {
    revokeBySession: async () => {},
    revokeByAccount: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-devices:${id}`);
    },
  } as unknown as DeviceCredentialRepository;

  const prepared = {
    code: {} as VerificationCodeEntity,
    plaintext: CODE,
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
  const issuer = {
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
    service: new PasswordsService(
      unitOfWork,
      accounts,
      codes,
      passwords,
      sessions,
      refreshTokens,
      deviceCredentials,
      issuer,
      ratePolicy,
      outbox,
    ),
    calls,
    transaction,
    events: () => events,
    updatedAccount: () => updatedAccountValue,
    updatedCodes: () => updatedCodeValues,
    prepare,
    issue,
    recordRequest,
    evaluate,
    hash,
    givenAccount: (value) => {
      foundAccount = value;
      lockedAccount = value;
    },
    givenLocked: (value) => {
      lockedAccount = value;
    },
    givenCode: (value) => {
      foundCode = value;
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
  throw new Error('expected the service to reject');
}

function forgotCommand(
  overrides: Partial<ForgotPasswordCommand> = {},
): ForgotPasswordCommand {
  return {
    email: ' User@Example.COM ',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function resetCommand(
  overrides: Partial<ResetPasswordCommand> = {},
): ResetPasswordCommand {
  return {
    email: ' User@Example.COM ',
    code: CODE,
    newPassword: NEW_PASSWORD,
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('PasswordsService (BR-05, BR-07, BR-08, BR-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a reset code for an eligible account', async () => {
    const h = harness();

    await expect(h.service.forgotPassword(forgotCommand())).resolves.toEqual({
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
    expect(h.prepare).toHaveBeenCalledWith('account-1', 'password_reset', NOW);
    expect(h.issue).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({
        account: expect.objectContaining({ id: 'account-1' }),
        purpose: 'password_reset' satisfies VerificationCodePurpose,
        prepared: expect.objectContaining({ plaintext: CODE }),
        correlationId: 'corr-1',
        now: NOW,
      }),
    );
    expect(h.recordRequest).not.toHaveBeenCalled();
  });

  it('records the counter for an unknown address without sending mail', async () => {
    const h = harness();
    h.givenAccount(null);

    await expect(h.service.forgotPassword(forgotCommand())).resolves.toEqual({
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

    const knownResult = await known.service.forgotPassword(forgotCommand());
    const unknownResult = await unknown.service.forgotPassword(forgotCommand());

    expect(Object.keys(knownResult)).toEqual(Object.keys(unknownResult));
    expect(knownResult).toEqual(unknownResult);
  });

  it('records the counter but sends nothing for a disabled account', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    await h.service.forgotPassword(forgotCommand());

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

    await h.service.forgotPassword(forgotCommand());

    expect(h.issue).not.toHaveBeenCalled();
    expect(h.recordRequest).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ accountId: 'account-1' }),
    );
  });

  it('returns the retry interval without touching the account on rate limit', async () => {
    const h = harness();
    h.givenRateDecision(false, 90);

    await expect(h.service.forgotPassword(forgotCommand())).resolves.toEqual({
      secondsRemaining: 90,
    });

    expect(h.calls).toEqual(['evaluate']);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.recordRequest).not.toHaveBeenCalled();
  });

  it('changes the password and revokes every session in one transaction', async () => {
    const h = harness();

    await expect(h.service.resetPassword(resetCommand())).resolves.toEqual({
      reset: true,
    });

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

    await h.service.resetPassword(resetCommand());

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
      h.service.resetPassword(resetCommand({ newPassword: 'short' })),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(h.hash).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('commits the failed attempt before rejecting a wrong code (BR-05)', async () => {
    const h = harness();

    const error = await errorOf(
      h.service.resetPassword(resetCommand({ code: '000000' })),
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
      code({
        codeHash: '00',
        codeSalt: '00',
        expiresAt: new Date(NOW.getTime() - 1),
      }),
      code({ consumedAt: NOW }),
      code({ attempts: 5 }),
      null,
    ];

    for (const value of cases) {
      const h = harness();
      h.givenCode(value);

      const error = await errorOf(h.service.resetPassword(resetCommand()));

      expect(error.code).toBe(ErrorCode.PASSWORD_RESET_INVALID);
      expect(h.updatedAccount()).toBeUndefined();
      expect(h.events()).toEqual([]);
    }
  });

  it('refuses to set the current password again', async () => {
    const h = harness();

    const error = await errorOf(
      h.service.resetPassword(resetCommand({ newPassword: CURRENT_PASSWORD })),
    );

    expect(error.code).toBe(ErrorCode.PASSWORD_REUSE);
    expect(h.updatedCodes()).toEqual([]);
    expect(h.updatedAccount()).toBeUndefined();
    expect(h.events()).toEqual([]);
  });

  it('uses one indistinguishable answer for an unknown address', async () => {
    const h = harness();
    h.givenAccount(null);

    const error = await errorOf(h.service.resetPassword(resetCommand()));

    expect(error.code).toBe(ErrorCode.PASSWORD_RESET_INVALID);
    expect(h.updatedCodes()).toEqual([]);
    expect(h.events()).toEqual([]);
  });

  it('refuses a disabled account', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    expect((await errorOf(h.service.resetPassword(resetCommand()))).code).toBe(
      ErrorCode.ACCOUNT_DISABLED,
    );
    expect(h.updatedAccount()).toBeUndefined();
  });
});
