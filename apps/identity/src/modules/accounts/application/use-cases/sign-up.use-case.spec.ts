import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  type AccountRegisteredEvent,
  type VerificationCodeIssuedEvent,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import {
  SignUpUseCase,
  type SignUpCommand,
} from './sign-up.use-case.js';
import { AuthError } from '../auth-error.js';
import { VerificationCodeIssuer } from '../services/verification-code.issuer.js';
import { VerificationRatePolicy } from '../services/verification-rate.policy.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../ports/password-hasher.port.js';
import type { VerificationCodeRepositoryPort } from '../ports/verification-code.repository.port.js';
import type { VerificationRequestRepositoryPort } from '../ports/verification-request.repository.port.js';
import { Account, type AccountStatus } from '../../domain/account.js';
import type { VerificationCode } from '../../domain/verification-code.js';
import { VerificationRequest } from '../../domain/verification-request.js';
import {
  VERIFICATION_RESEND_WAIT_SECONDS,
  VERIFICATION_WINDOW_SECONDS,
} from '../../domain/verification-request.js';
import { verifyVerificationCode } from '../../domain/verification-code.hashing.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASSWORD = 'Str0ng!Pass';

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

interface Harness {
  useCase: SignUpUseCase;
  calls: string[];
  transaction: TransactionContext;
  savedAccount(): Account | undefined;
  updatedAccount(): Account | undefined;
  savedCode(): VerificationCode | undefined;
  savedRequests(): VerificationRequest[];
  events(): (AccountRegisteredEvent | VerificationCodeIssuedEvent)[];
  registeredEvent(): AccountRegisteredEvent | undefined;
  verificationEvent(): VerificationCodeIssuedEvent | undefined;
  givenExisting(account: Account | null): void;
  givenLatest(request: VerificationRequest | null): void;
  givenRequestCount(count: number): void;
  accounts: AccountRepositoryPort;
  codes: VerificationCodeRepositoryPort;
  requests: VerificationRequestRepositoryPort;
  outbox: OutboxPort;
  unitOfWork: UnitOfWorkPort;
}

function harness(verificationCodeTtlSeconds = 600): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let existing: Account | null = null;
  let latest: VerificationRequest | null = null;
  let requestCount = 0;
  let account: Account | undefined;
  let updated: Account | undefined;
  let code: VerificationCode | undefined;
  const requests: VerificationRequest[] = [];
  const appended: (AccountRegisteredEvent | VerificationCodeIssuedEvent)[] = [];

  const accounts: AccountRepositoryPort = {
    save: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('account');
      account = value;
    },
    update: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('account-update');
      updated = value;
    },
    findByEmail: async () => existing,
    findById: async () => existing,
    findByEmailForUpdate: async () => existing,
    findByIdForUpdate: async () => existing,
  };
  const codes: VerificationCodeRepositoryPort = {
    save: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('code');
      code = value;
    },
    update: async () => {},
    findLatestLive: async () => null,
    consumeLive: async (received) => {
      expect(received).toBe(transaction);
      calls.push('consume-live');
    },
  };
  const requestRepository: VerificationRequestRepositoryPort = {
    record: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('request');
      requests.push(value);
    },
    latestForEmail: async () => latest,
    countSince: async () => requestCount,
  };
  const outbox: OutboxPort = {
    append: async (received, value) => {
      expect(received).toBe(transaction);
      appended.push(
        value as AccountRegisteredEvent | VerificationCodeIssuedEvent,
      );
      calls.push(
        value.type === 'identity.account.registered'
          ? 'outbox-account'
          : 'outbox-verification',
      );
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
  const passwords: PasswordHasherPort = {
    hash: async (plaintext) => {
      calls.push('hash');
      return digest(plaintext);
    },
    verify: async (plaintext, hashValue) => digest(plaintext) === hashValue,
  };

  const issuers = new VerificationCodeIssuer(
    codes,
    requestRepository,
    outbox,
    {
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
      refreshGraceSeconds: 10,
      verificationCodeTtlSeconds,
    },
  );
  const ratePolicy = new VerificationRatePolicy(requestRepository);

  return {
    useCase: new SignUpUseCase(
      unitOfWork,
      accounts,
      passwords,
      issuers,
      ratePolicy,
      outbox,
    ),
    calls,
    transaction,
    savedAccount: () => account,
    updatedAccount: () => updated,
    savedCode: () => code,
    savedRequests: () => requests,
    events: () => appended,
    registeredEvent: () =>
      appended.find((event) => event.type === 'identity.account.registered') as
        | AccountRegisteredEvent
        | undefined,
    verificationEvent: () =>
      appended.find(
        (event) => event.type === 'identity.verification-code.issued',
      ) as VerificationCodeIssuedEvent | undefined,
    givenExisting: (value) => {
      existing = value;
    },
    givenLatest: (value) => {
      latest = value;
    },
    givenRequestCount: (value) => {
      requestCount = value;
    },
    accounts,
    codes,
    requests: requestRepository,
    outbox,
    unitOfWork,
  };
}

function command(overrides: Partial<SignUpCommand> = {}): SignUpCommand {
  return {
    email: '  User@Example.COM ',
    password: PASSWORD,
    correlationId: 'corr-1',
    ...overrides,
  };
}

function existingAccount(
  status: AccountStatus = 'pending',
  email = 'user@example.com',
): Account {
  return Account.restore({
    id: '99999999-9999-4999-8999-999999999999',
    email,
    language: 'ar',
    status,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    passwordHash: digest('OldPassword1!'),
    passwordUpdatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
}

async function authErrorOf(
  promise: Promise<unknown>,
): Promise<AuthError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected the use case to reject');
}

describe('SignUpUseCase (ADR-0001, BR-02, BR-03, BR-56)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('injects the transaction, repositories, hasher and outbox', () => {
    type Dependency = { index: number; param: unknown };
    const dependencies = ((Reflect.getMetadata(
      'self:paramtypes',
      SignUpUseCase,
    ) ?? []) as Dependency[]).sort((left, right) => left.index - right.index);

    expect(dependencies.map((entry) => entry.index)).toEqual([0, 1, 2, 5]);
    expect(dependencies.map((entry) => entry.param)).toEqual([
      UNIT_OF_WORK,
      ACCOUNT_REPOSITORY,
      PASSWORD_HASHER,
      OUTBOX,
    ]);
    // The two collaborators are concrete application services, not ports.
    expect(SignUpUseCase.length).toBe(6);
  });

  it('writes the account, code, request and both events on one transaction', async () => {
    const h = harness();

    const result = await h.useCase.execute(command());

    expect(h.calls).toEqual([
      'hash',
      'begin',
      'account',
      'consume-live',
      'code',
      'request',
      'outbox-verification',
      'outbox-account',
      'commit',
    ]);
    expect(result).toEqual({
      accountId: expect.stringMatching(UUID),
      maskedEmail: 'u***@example.com',
      language: 'ar',
      resendAfterSeconds: VERIFICATION_RESEND_WAIT_SECONDS,
    });

    const account = h.savedAccount();
    expect(account?.id).toBe(result.accountId);
    expect(account?.email).toBe('user@example.com');
    expect(account?.language).toBe('ar');
    expect(account?.status).toBe('pending');
    expect(account?.createdAt).toEqual(NOW);
    expect(account?.passwordHash).toBe(digest(PASSWORD));
    expect(account?.passwordUpdatedAt).toEqual(NOW);

    const code = h.savedCode();
    expect(code?.accountId).toBe(result.accountId);
    expect(code?.purpose).toBe('sign_up');
    expect(code?.issuedAt).toEqual(NOW);
    expect(code?.expiresAt).toEqual(new Date(NOW.getTime() + 600_000));

    expect(h.savedRequests()).toHaveLength(1);
    expect(h.savedRequests()[0]).toMatchObject({
      email: 'user@example.com',
      accountId: result.accountId,
      purpose: 'sign_up',
      issuedAt: NOW,
    });
  });

  it('never returns or stores the plaintext password or e-mail', async () => {
    const h = harness();

    const result = await h.useCase.execute(command());

    expect(Object.keys(result).sort()).toEqual([
      'accountId',
      'language',
      'maskedEmail',
      'resendAfterSeconds',
    ]);
    expect(JSON.stringify(result)).not.toContain('user@example.com');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(h.savedAccount())).not.toContain(PASSWORD);
    // The account row needs the address to send the code; only the response
    // and the logs must carry the mask.
    expect(h.savedAccount()?.email).toBe('user@example.com');
    expect(result.maskedEmail).not.toBe('user@example.com');
  });

  it('puts the code plaintext only in the event and stores a hash', async () => {
    const h = harness();

    await h.useCase.execute(command());

    const code = h.savedCode()!;
    const event = h.verificationEvent()!;
    expect(event.payload.code).toMatch(/^\d{6}$/);
    expect(code.codeHash).not.toBe(event.payload.code);
    expect(code.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyVerificationCode(event.payload.code, code.codeSalt, code.codeHash),
    ).toBe(true);
    expect(JSON.stringify(code)).not.toContain(event.payload.code);
  });

  it('emits account.registered once the account is durable', async () => {
    const h = harness();
    const result = await h.useCase.execute(command());

    const event = h.registeredEvent()!;
    expect(event.id).toMatch(UUID);
    expect(event.type).toBe('identity.account.registered');
    expect(event.version).toBe(1);
    expect(event.producer).toBe('identity');
    expect(event.correlationId).toBe('corr-1');
    expect(event.occurredAt).toBe(NOW.toISOString());
    expect(event.payload).toEqual({
      accountId: result.accountId,
      email: 'user@example.com',
      language: 'ar',
      registeredAt: NOW.toISOString(),
    });
  });

  it('builds the verification event clock at issuance', async () => {
    const h = harness();
    const result = await h.useCase.execute(command());

    const event = h.verificationEvent()!;
    expect(event.id).toMatch(UUID);
    expect(event.type).toBe('identity.verification-code.issued');
    expect(event.correlationId).toBe('corr-1');
    expect(event.payload).toEqual({
      accountId: result.accountId,
      email: 'user@example.com',
      code: expect.stringMatching(/^\d{6}$/),
      purpose: 'sign_up',
      language: 'ar',
      issuedAt: NOW.toISOString(),
      expiresAt: '2026-10-24T10:10:00.000Z',
    });
  });

  it('honours the configured TTL inside the ten-minute cap', async () => {
    // Injected, not stubbed: the issuer takes its TTL from TOKEN_SETTINGS, so
    // an environment stub here would be inert and the assertion vacuous.
    const h = harness(60);

    await h.useCase.execute(command());

    expect(h.verificationEvent()!.payload.expiresAt).toBe(
      '2026-10-24T10:01:00.000Z',
    );
    expect(h.savedCode()!.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('keeps English and falls back to Arabic for anything else (BR-56)', async () => {
    const english = harness();
    await english.useCase.execute(command({ language: 'en' }));
    expect(english.savedAccount()?.language).toBe('en');
    expect(english.registeredEvent()?.payload.language).toBe('en');

    const unsupported = harness();
    await unsupported.useCase.execute(command({ language: 'fr' as never }));
    expect(unsupported.savedAccount()?.language).toBe('ar');
    expect(unsupported.registeredEvent()?.payload.language).toBe('ar');
  });

  it('rejects a weak password before touching the database', async () => {
    const h = harness();

    const error = await authErrorOf(
      h.useCase.execute(command({ password: 'short' })),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.message).toMatch(/at least 8/);
    expect(h.calls).toEqual([]);
  });

  it('does not open a transaction for an invalid address', async () => {
    const h = harness();

    await expect(
      h.useCase.execute(command({ email: 'not-an-address' })),
    ).rejects.toThrow(/valid email/i);
    expect(h.calls).toEqual(['hash']);
  });

  it('reissues credentials for a pending account without a second account row', async () => {
    const h = harness();
    const existing = existingAccount();
    h.givenExisting(existing);

    const result = await h.useCase.execute(command());

    expect(result.accountId).toBe(existing.id);
    expect(h.calls).toEqual([
      'hash',
      'begin',
      'account-update',
      'consume-live',
      'code',
      'request',
      'outbox-verification',
      'commit',
    ]);
    expect(h.updatedAccount()?.passwordHash).toBe(digest(PASSWORD));
    expect(h.updatedAccount()?.passwordUpdatedAt).toEqual(NOW);
    expect(h.registeredEvent()).toBeUndefined();
    expect(h.savedAccount()).toBeUndefined();
  });

  it('applies the durable resend window to a pending re-sign-up', async () => {
    const h = harness();
    h.givenExisting(existingAccount());
    h.givenLatest(
      new VerificationRequest(
        'req-1',
        'user@example.com',
        '99999999-9999-4999-8999-999999999999',
        'sign_up',
        new Date(NOW.getTime() - 30_000),
      ),
    );

    const error = await authErrorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.RESEND_TOO_SOON);
    expect(error.retryAfterSeconds).toBe(VERIFICATION_RESEND_WAIT_SECONDS - 30);
    expect(h.calls).toEqual([]);
  });

  it('enforces the hourly issuance cap even without a recent code', async () => {
    const h = harness();
    h.givenExisting(existingAccount());
    h.givenRequestCount(5);

    const error = await authErrorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.RESEND_TOO_SOON);
    expect(error.retryAfterSeconds).toBe(VERIFICATION_WINDOW_SECONDS);
    expect(h.calls).toEqual([]);
  });

  it('refuses a verified address and a disabled account with distinct codes', async () => {
    const verified = harness();
    verified.givenExisting(existingAccount('active'));
    expect((await authErrorOf(verified.useCase.execute(command()))).code).toBe(
      ErrorCode.EMAIL_ALREADY_REGISTERED,
    );

    const disabled = harness();
    disabled.givenExisting(existingAccount('disabled'));
    expect((await authErrorOf(disabled.useCase.execute(command()))).code).toBe(
      ErrorCode.ACCOUNT_DISABLED,
    );
    expect(disabled.calls).toEqual([]);
  });

  it('maps a unique violation from a concurrent sign-up to the same conflict', async () => {
    const h = harness();
    h.accounts.save = async () => {
      h.calls.push('account');
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    };

    const error = await authErrorOf(h.useCase.execute(command()));

    expect(error.code).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
    expect(h.calls).toEqual(['hash', 'begin', 'account']);
    expect(h.events()).toEqual([]);
  });

  it('does not leak an unrelated failure as a conflict', async () => {
    const h = harness();
    h.accounts.save = async () => {
      h.calls.push('account');
      throw new Error('connection reset');
    };

    await expect(h.useCase.execute(command())).rejects.toThrow(
      'connection reset',
    );
    expect(h.calls).toEqual(['hash', 'begin', 'account']);
    expect(h.events()).toEqual([]);
  });
});
