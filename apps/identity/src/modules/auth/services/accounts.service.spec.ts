import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  type AccountRegisteredEvent,
  type EmailVerifiedEvent,
  type VerificationCodeIssuedEvent,
  type VerificationCodePurpose,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import {
  AccountsService,
  type ResendVerificationCommand,
  type SignUpCommand,
  type VerifyEmailCommand,
} from './accounts.service.js';
import { AuthError } from '../auth-error.js';
import { BcryptPasswordHasher } from '../bcrypt-password.hasher.js';
import {
  AccountEntity,
  type AccountStatus,
} from '../entities/account.entity.js';
import { VerificationCodeEntity } from '../entities/verification-code.entity.js';
import type { VerificationRequestEntity } from '../entities/verification-request.entity.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { VerificationCodeRepository } from '../repositories/verification-code.repository.js';
import { VerificationRequestRepository } from '../repositories/verification-request.repository.js';
import { SessionIssuer } from '../session.issuer.js';
import {
  generateVerificationCodeSalt,
  hashVerificationCode,
  verifyVerificationCode,
} from '../verification-code.hashing.js';
import { VerificationCodeIssuer } from '../verification-code.issuer.js';
import {
  VERIFICATION_RESEND_WAIT_SECONDS,
  VERIFICATION_WINDOW_SECONDS,
  VerificationRatePolicy,
} from '../verification-rate.policy.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASSWORD = 'Str0ng!Pass';
const CODE = '123456';
const TOKENS = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer' as const,
  accessExpiresIn: TOKEN_DEFAULTS.accessTtlSeconds,
  refreshExpiresIn: TOKEN_DEFAULTS.refreshTtlSeconds,
};

type IdentityEvent =
  AccountRegisteredEvent | EmailVerifiedEvent | VerificationCodeIssuedEvent;

interface RecordedRequest {
  id: string;
  email: string;
  accountId: string | null;
  purpose: VerificationCodePurpose;
  issuedAt: Date;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function account(
  status: AccountStatus = 'pending',
  email = 'user@example.com',
): AccountEntity {
  const row = new AccountEntity();
  row.id = 'account-1';
  row.email = email;
  row.language = 'ar';
  row.status = status;
  row.createdAt = new Date('2026-10-01T00:00:00.000Z');
  row.passwordHash = digest('OldPassword1!');
  row.passwordUpdatedAt = new Date('2026-10-01T00:00:00.000Z');
  row.emailVerifiedAt =
    status === 'active' ? new Date('2026-10-01T00:00:00.000Z') : null;
  row.bookable = false;
  row.roles = [];
  return row;
}

function verificationCode(
  overrides: Partial<VerificationCodeEntity> = {},
): VerificationCodeEntity {
  const salt = generateVerificationCodeSalt();
  const row = new VerificationCodeEntity();
  row.id = 'code-1';
  row.accountId = 'account-1';
  row.purpose = 'sign_up';
  row.codeHash = hashVerificationCode(CODE, salt);
  row.codeSalt = salt;
  row.issuedAt = NOW;
  row.expiresAt = new Date(NOW.getTime() + 600_000);
  row.consumedAt = null;
  row.attempts = 0;
  row.maxAttempts = 5;
  return Object.assign(row, overrides);
}

function request(
  email = 'user@example.com',
  issuedAt: Date = NOW,
): VerificationRequestEntity {
  const row = {} as VerificationRequestEntity;
  row.id = 'request-1';
  row.email = email;
  row.accountId = 'account-1';
  row.purpose = 'sign_up';
  row.issuedAt = issuedAt;
  return row;
}

interface HarnessOptions {
  account?: AccountEntity | null;
  locked?: AccountEntity | null;
  verificationCodeTtlSeconds?: number;
}

interface Harness {
  service: AccountsService;
  calls: string[];
  transaction: TransactionContext;
  savedAccount(): AccountEntity | undefined;
  updatedAccount(): AccountEntity | undefined;
  savedCode(): VerificationCodeEntity | undefined;
  updatedCodes(): VerificationCodeEntity[];
  savedRequests(): RecordedRequest[];
  events(): IdentityEvent[];
  registeredEvent(): AccountRegisteredEvent | undefined;
  verificationEvent(): VerificationCodeIssuedEvent | undefined;
  issue: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  hash: ReturnType<typeof vi.fn>;
  givenAccount(value: AccountEntity | null): void;
  givenLocked(value: AccountEntity | null): void;
  givenCode(value: VerificationCodeEntity | null): void;
  givenLatest(value: VerificationRequestEntity | null): void;
  givenRequestCount(value: number): void;
  accounts: AccountRepository;
}

function harness(options: HarnessOptions = {}): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundAccount: AccountEntity | null = options.account ?? null;
  let lockedAccount: AccountEntity | null =
    options.locked !== undefined ? options.locked : foundAccount;
  let foundCode: VerificationCodeEntity | null = null;
  let latest: VerificationRequestEntity | null = null;
  let requestCount = 0;
  let saved: AccountEntity | undefined;
  let updated: AccountEntity | undefined;
  let code: VerificationCodeEntity | undefined;
  const updatedCodeValues: VerificationCodeEntity[] = [];
  const requests: RecordedRequest[] = [];
  const appended: IdentityEvent[] = [];

  const accounts = {
    save: async (received: TransactionContext, value: AccountEntity) => {
      expect(received).toBe(transaction);
      calls.push('account');
      saved = value;
    },
    update: async (received: TransactionContext, value: AccountEntity) => {
      expect(received).toBe(transaction);
      calls.push('account-update');
      updated = value;
    },
    findByEmail: async () => foundAccount,
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
    save: async (
      received: TransactionContext,
      value: VerificationCodeEntity,
    ) => {
      expect(received).toBe(transaction);
      calls.push('code');
      code = value;
    },
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
      expect(purpose).toBe('sign_up');
      expect(options).toEqual({ forUpdate: true });
      calls.push('find-code');
      return foundCode;
    },
    consumeLive: async (received: TransactionContext) => {
      expect(received).toBe(transaction);
      calls.push('consume-live');
    },
  } as unknown as VerificationCodeRepository;

  const requestRepository = {
    record: async (received: TransactionContext, value: RecordedRequest) => {
      expect(received).toBe(transaction);
      calls.push('request');
      requests.push(value);
    },
    latestForEmail: async () => latest,
    countSince: async () => requestCount,
  } as unknown as VerificationRequestRepository;

  const outbox: OutboxPort = {
    append: async (received, value) => {
      expect(received).toBe(transaction);
      appended.push(value as IdentityEvent);
      calls.push(
        value.type === 'identity.account.registered'
          ? 'outbox-account'
          : value.type === 'identity.email.verified'
            ? 'outbox'
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
  const hash = vi.fn(async (plaintext: string) => {
    calls.push('hash');
    return digest(plaintext);
  });
  const verify = vi.fn(
    async (plaintext: string, hashValue: string) =>
      digest(plaintext) === hashValue,
  );
  const passwords = { hash, verify } as unknown as BcryptPasswordHasher;

  const issuer = new VerificationCodeIssuer(codes, requestRepository, outbox, {
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
    refreshGraceSeconds: 10,
    verificationCodeTtlSeconds: options.verificationCodeTtlSeconds ?? 600,
  });
  const ratePolicy = new VerificationRatePolicy(requestRepository);
  const issue = vi.fn(async () => ({
    tokens: TOKENS,
    session: {} as never,
    refreshToken: {} as never,
    accessExpiresAt: new Date(NOW.getTime() + 900_000),
  }));
  const sessions = { issue } as unknown as SessionIssuer;

  return {
    service: new AccountsService(
      unitOfWork,
      accounts,
      passwords,
      codes,
      issuer,
      ratePolicy,
      sessions,
      outbox,
    ),
    calls,
    transaction,
    savedAccount: () => saved,
    updatedAccount: () => updated,
    savedCode: () => code,
    updatedCodes: () => updatedCodeValues,
    savedRequests: () => requests,
    events: () => appended,
    registeredEvent: () =>
      appended.find((event) => event.type === 'identity.account.registered') as
        AccountRegisteredEvent | undefined,
    verificationEvent: () =>
      appended.find(
        (event) => event.type === 'identity.verification-code.issued',
      ) as VerificationCodeIssuedEvent | undefined,
    issue,
    verify,
    hash,
    givenAccount: (value) => {
      foundAccount = value;
    },
    givenLocked: (value) => {
      lockedAccount = value;
    },
    givenCode: (value) => {
      foundCode = value;
    },
    givenLatest: (value) => {
      latest = value;
    },
    givenRequestCount: (value) => {
      requestCount = value;
    },
    accounts,
  };
}

function signUpCommand(overrides: Partial<SignUpCommand> = {}): SignUpCommand {
  return {
    email: '  User@Example.COM ',
    password: PASSWORD,
    correlationId: 'corr-1',
    ...overrides,
  };
}

function verifyCommand(
  overrides: Partial<VerifyEmailCommand> = {},
): VerifyEmailCommand {
  return {
    email: 'user@example.com',
    code: CODE,
    deviceId: 'device-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function resendCommand(
  overrides: Partial<ResendVerificationCommand> = {},
): ResendVerificationCommand {
  return {
    email: 'user@example.com',
    correlationId: 'corr-1',
    ...overrides,
  };
}

async function authErrorOf(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('expected the service to reject');
}

describe('AccountsService (ADR-0001, BR-02, BR-03, BR-05, BR-56)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('injects the transaction and outbox as symbols, with concrete collaborators', () => {
    type Dependency = { index: number; param: unknown };
    const dependencies = (
      (Reflect.getMetadata('self:paramtypes', AccountsService) ??
        []) as Dependency[]
    ).sort((left, right) => left.index - right.index);

    expect(dependencies.map((entry) => entry.index)).toEqual([0, 7]);
    expect(dependencies.map((entry) => entry.param)).toEqual([
      UNIT_OF_WORK,
      OUTBOX,
    ]);
    // The remaining collaborators are concrete classes, not DI tokens.
    expect(AccountsService.length).toBe(8);
  });

  it('writes the account, code, request and both events on one transaction', async () => {
    const h = harness();

    const result = await h.service.signUp(signUpCommand());

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

    const saved = h.savedAccount();
    expect(saved?.id).toBe(result.accountId);
    expect(saved?.email).toBe('user@example.com');
    expect(saved?.language).toBe('ar');
    expect(saved?.status).toBe('pending');
    expect(saved?.createdAt).toEqual(NOW);
    expect(saved?.passwordHash).toBe(digest(PASSWORD));
    expect(saved?.passwordUpdatedAt).toEqual(NOW);
    expect(saved?.emailVerifiedAt).toBeNull();

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

    const result = await h.service.signUp(signUpCommand());

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

    await h.service.signUp(signUpCommand());

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
    const result = await h.service.signUp(signUpCommand());

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
    const result = await h.service.signUp(signUpCommand());

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
    const h = harness({ verificationCodeTtlSeconds: 60 });

    await h.service.signUp(signUpCommand());

    expect(h.verificationEvent()!.payload.expiresAt).toBe(
      '2026-10-24T10:01:00.000Z',
    );
    expect(h.savedCode()!.expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('rejects a TTL above the ten-minute cap', async () => {
    const h = harness({ verificationCodeTtlSeconds: 601 });

    await expect(h.service.signUp(signUpCommand())).rejects.toThrow(
      /between 1 and 600/i,
    );
    expect(h.calls).toEqual(['hash']);
  });

  it('keeps English and falls back to Arabic for anything else (BR-56)', async () => {
    const english = harness();
    await english.service.signUp(signUpCommand({ language: 'en' }));
    expect(english.savedAccount()?.language).toBe('en');
    expect(english.registeredEvent()?.payload.language).toBe('en');

    const unsupported = harness();
    await unsupported.service.signUp(
      signUpCommand({ language: 'fr' as never }),
    );
    expect(unsupported.savedAccount()?.language).toBe('ar');
    expect(unsupported.registeredEvent()?.payload.language).toBe('ar');
  });

  it('rejects a weak password before touching the database', async () => {
    const h = harness();

    const error = await authErrorOf(
      h.service.signUp(signUpCommand({ password: 'short' })),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.message).toMatch(/at least 8/);
    expect(h.calls).toEqual([]);
  });

  it('normalizes the address and rejects one without an @', async () => {
    const h = harness();

    await expect(
      h.service.signUp(signUpCommand({ email: 'not-an-address' })),
    ).rejects.toThrow(/valid email/i);
    expect(h.calls).toEqual([]);
  });

  it('reissues credentials for a pending account without a second account row', async () => {
    const h = harness({ account: account() });

    const result = await h.service.signUp(signUpCommand());

    expect(result.accountId).toBe('account-1');
    expect(h.calls).toEqual([
      'hash',
      'begin',
      'lock-account:user@example.com',
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
    const h = harness({ account: account() });
    h.givenLatest(
      request('user@example.com', new Date(NOW.getTime() - 30_000)),
    );

    const error = await authErrorOf(h.service.signUp(signUpCommand()));

    expect(error.code).toBe(ErrorCode.RESEND_TOO_SOON);
    expect(error.retryAfterSeconds).toBe(VERIFICATION_RESEND_WAIT_SECONDS - 30);
    expect(h.calls).toEqual([]);
  });

  it('enforces the hourly issuance cap even without a recent code', async () => {
    const h = harness({ account: account() });
    h.givenRequestCount(5);

    const error = await authErrorOf(h.service.signUp(signUpCommand()));

    expect(error.code).toBe(ErrorCode.RESEND_TOO_SOON);
    expect(error.retryAfterSeconds).toBe(VERIFICATION_WINDOW_SECONDS);
    expect(h.calls).toEqual([]);
  });

  it('refuses a verified address and a disabled account with distinct codes', async () => {
    const verified = harness({ account: account('active') });
    expect(
      (await authErrorOf(verified.service.signUp(signUpCommand()))).code,
    ).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);

    const disabled = harness({ account: account('disabled') });
    expect(
      (await authErrorOf(disabled.service.signUp(signUpCommand()))).code,
    ).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(disabled.calls).toEqual([]);
  });

  it('maps a unique violation from a concurrent sign-up to the same conflict', async () => {
    const h = harness();
    h.accounts.save = async () => {
      h.calls.push('account');
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    };

    const error = await authErrorOf(h.service.signUp(signUpCommand()));

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

    await expect(h.service.signUp(signUpCommand())).rejects.toThrow(
      'connection reset',
    );
    expect(h.calls).toEqual(['hash', 'begin', 'account']);
    expect(h.events()).toEqual([]);
  });

  it('consumes the code, activates the account and starts a session atomically', async () => {
    const h = harness({ account: account(), locked: account() });
    h.givenCode(verificationCode());

    const result = await h.service.verifyEmail(verifyCommand());

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
    const h = harness({ account: account(), locked: account() });
    h.givenCode(verificationCode());

    await h.service.verifyEmail(verifyCommand());

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
    const h = harness({ account: account(), locked: account() });
    h.givenCode(verificationCode());

    const error = await authErrorOf(
      h.service.verifyEmail(verifyCommand({ code: '000000' })),
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
    const h = harness({ account: account(), locked: account() });
    h.givenCode(
      verificationCode({
        codeHash: '00',
        codeSalt: '00',
        expiresAt: new Date(NOW.getTime() - 1),
      }),
    );

    const error = await authErrorOf(h.service.verifyEmail(verifyCommand()));

    expect(error.code).toBe(ErrorCode.VERIFICATION_CODE_EXPIRED);
    expect(h.updatedCodes()).toEqual([]);
  });

  it('treats the exact expiry instant as expired', async () => {
    const h = harness({ account: account(), locked: account() });
    h.givenCode(verificationCode({ expiresAt: NOW }));

    const error = await authErrorOf(h.service.verifyEmail(verifyCommand()));

    expect(error.code).toBe(ErrorCode.VERIFICATION_CODE_EXPIRED);
    expect(h.updatedCodes()).toEqual([]);
  });

  it('rejects a consumed code and an exhausted code without another write', async () => {
    const consumed = harness({ account: account(), locked: account() });
    consumed.givenCode(verificationCode({ consumedAt: NOW }));
    expect(
      (await authErrorOf(consumed.service.verifyEmail(verifyCommand()))).code,
    ).toBe(ErrorCode.INVALID_VERIFICATION_CODE);
    expect(consumed.updatedCodes()).toEqual([]);

    const exhausted = harness({ account: account(), locked: account() });
    exhausted.givenCode(verificationCode({ attempts: 5 }));
    expect(
      (await authErrorOf(exhausted.service.verifyEmail(verifyCommand()))).code,
    ).toBe(ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED);
    expect(exhausted.updatedCodes()).toEqual([]);
  });

  it('answers an unknown account exactly like a wrong code', async () => {
    const h = harness({ account: null, locked: null });

    const error = await authErrorOf(h.service.verifyEmail(verifyCommand()));

    expect(error.code).toBe(ErrorCode.INVALID_VERIFICATION_CODE);
    expect(h.calls).toEqual([
      'begin',
      'lock-account:user@example.com',
      'commit',
    ]);
  });

  it('refuses a disabled account even with a valid code (BR-09)', async () => {
    const h = harness({
      account: account('disabled'),
      locked: account('disabled'),
    });
    h.givenCode(verificationCode());

    const error = await authErrorOf(h.service.verifyEmail(verifyCommand()));

    expect(error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(h.updatedCodes()).toEqual([]);
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('issues a fresh code for a pending account', async () => {
    const h = harness({ account: account(), locked: account() });

    await expect(
      h.service.resendVerification(resendCommand()),
    ).resolves.toEqual({
      maskedEmail: 'u***@example.com',
      secondsRemaining: VERIFICATION_RESEND_WAIT_SECONDS,
    });

    expect(h.calls).toEqual([
      'begin',
      'lock-account:user@example.com',
      'consume-live',
      'code',
      'request',
      'outbox-verification',
      'commit',
    ]);
    expect(h.savedCode()).toMatchObject({
      accountId: 'account-1',
      purpose: 'sign_up',
      issuedAt: NOW,
    });
  });

  it('returns the durable retry window instead of issuing', async () => {
    const h = harness({ account: account(), locked: account() });
    h.givenLatest(
      request('user@example.com', new Date(NOW.getTime() - 30_000)),
    );

    const error = await authErrorOf(
      h.service.resendVerification(resendCommand()),
    );

    expect(error.code).toBe(ErrorCode.RESEND_TOO_SOON);
    expect(error.retryAfterSeconds).toBe(90);
    expect(h.calls).toEqual([]);
    expect(h.savedCode()).toBeUndefined();
  });

  it('refuses to resend for an address that no longer exists', async () => {
    const h = harness({ account: null });

    expect(
      (await authErrorOf(h.service.resendVerification(resendCommand()))).code,
    ).toBe(ErrorCode.RESOURCE_NOT_FOUND);
    expect(h.savedCode()).toBeUndefined();
  });

  it('refuses to resend for a verified or disabled account', async () => {
    const verified = harness({ account: account('active') });
    expect(
      (await authErrorOf(verified.service.resendVerification(resendCommand())))
        .code,
    ).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);

    const disabled = harness({ account: account('disabled') });
    expect(
      (await authErrorOf(disabled.service.resendVerification(resendCommand())))
        .code,
    ).toBe(ErrorCode.ACCOUNT_DISABLED);
  });

  it('rechecks state under the row lock before issuing', async () => {
    const h = harness({ account: account(), locked: account('active') });

    expect(
      (await authErrorOf(h.service.resendVerification(resendCommand()))).code,
    ).toBe(ErrorCode.EMAIL_ALREADY_REGISTERED);
    expect(h.savedCode()).toBeUndefined();
  });

  it('refuses when the account disappeared between the read and the lock', async () => {
    const h = harness({ account: account(), locked: null });

    expect(
      (await authErrorOf(h.service.resendVerification(resendCommand()))).code,
    ).toBe(ErrorCode.RESOURCE_NOT_FOUND);
    expect(h.savedCode()).toBeUndefined();
  });
});
