import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  type RefreshResponseDto,
  type SessionRevokedEvent,
  type SignInResponseDto,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import {
  SIGN_IN_LOCK_SECONDS,
  SIGN_IN_LOCK_THRESHOLD,
  SessionsService,
  type RefreshCommand,
  type SignInCommand,
  type SignOutCommand,
} from './sessions.service.js';
import { AuthError } from '../auth-error.js';
import { BcryptPasswordHasher } from '../bcrypt-password.hasher.js';
import { AccountEntity } from '../entities/account.entity.js';
import { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { SessionEntity } from '../entities/session.entity.js';
import { SignInLockoutEntity } from '../entities/sign-in-lockout.entity.js';
import { NodeRefreshTokenHasher } from '../node-refresh-token.hasher.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { DeviceCredentialRepository } from '../repositories/device-credential.repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { SignInLockoutRepository } from '../repositories/sign-in-lockout.repository.js';
import { SessionIssuer } from '../session.issuer.js';
import { VerificationRatePolicy } from '../verification-rate.policy.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const PASSWORD = 'Str0ng!Pass';
const RAW_TOKEN = 'raw-refresh-token';
const HASH = `hash:${RAW_TOKEN}`;
const EXPIRES_AT = new Date(NOW.getTime() + 900_000);
const TOKENS = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tokenType: 'Bearer' as const,
  accessExpiresIn: TOKEN_DEFAULTS.accessTtlSeconds,
  refreshExpiresIn: TOKEN_DEFAULTS.refreshTtlSeconds,
};
const NEW_TOKENS: RefreshResponseDto = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  tokenType: 'Bearer',
  accessExpiresIn: TOKEN_DEFAULTS.accessTtlSeconds,
  refreshExpiresIn: TOKEN_DEFAULTS.refreshTtlSeconds,
};

function account(
  status: 'pending' | 'active' | 'disabled' = 'active',
  passwordHash = 'stored-hash',
): AccountEntity {
  const row = new AccountEntity();
  row.id = 'account-1';
  row.email = 'user@example.com';
  row.language = 'ar';
  row.status = status;
  row.createdAt = new Date('2026-10-01T00:00:00.000Z');
  row.passwordHash = passwordHash;
  row.passwordUpdatedAt = new Date('2026-10-01T00:00:00.000Z');
  row.emailVerifiedAt =
    status === 'active' ? new Date('2026-10-01T00:00:00.000Z') : null;
  row.bookable = false;
  row.roles = [];
  return row;
}

function session(overrides: Partial<SessionEntity> = {}): SessionEntity {
  const row = new SessionEntity();
  row.id = 'session-1';
  row.accountId = 'account-1';
  row.createdAt = new Date('2026-10-01T00:00:00.000Z');
  row.lastUsedAt = new Date('2026-10-01T00:00:00.000Z');
  row.expiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  row.revokedAt = null;
  row.revokedReason = null;
  row.reuseDetectedAt = null;
  return Object.assign(row, overrides);
}

function token(
  overrides: Partial<RefreshTokenEntity> = {},
): RefreshTokenEntity {
  const row = new RefreshTokenEntity();
  row.id = 'token-1';
  row.sessionId = 'session-1';
  row.tokenHash = HASH;
  row.status = 'active';
  row.issuedAt = NOW;
  row.expiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
  row.rotatedAt = null;
  row.replacedById = null;
  row.gracePayload = null;
  row.graceExpiresAt = null;
  row.revokedAt = null;
  return Object.assign(row, overrides);
}

function lockout(
  failedCount = 0,
  lockedUntil: Date | null = null,
  email = 'user@example.com',
): SignInLockoutEntity {
  const row = new SignInLockoutEntity();
  row.email = email;
  row.failedCount = failedCount;
  row.lockedUntil = lockedUntil;
  row.updatedAt = NOW;
  return row;
}

interface Harness {
  service: SessionsService;
  calls: string[];
  transaction: TransactionContext;
  savedLockouts(): SignInLockoutEntity[];
  updatedTokens(): RefreshTokenEntity[];
  events(): SessionRevokedEvent[];
  issue: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  replay: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  hash: ReturnType<typeof vi.fn>;
  dummyHash: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  givenAccount(value: AccountEntity | null): void;
  givenLockout(value: SignInLockoutEntity | null): void;
  givenSession(value: SessionEntity | null): void;
  givenToken(value: RefreshTokenEntity | null): void;
  givenReplay(value: RefreshResponseDto | null): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundAccount: AccountEntity | null = account();
  let foundLockout: SignInLockoutEntity | null = null;
  let foundSession: SessionEntity | null = session();
  let foundToken: RefreshTokenEntity | null = token();
  let replayValue: RefreshResponseDto | null = NEW_TOKENS;
  const lockoutsWritten: SignInLockoutEntity[] = [];
  const tokensUpdated: RefreshTokenEntity[] = [];
  const events: SessionRevokedEvent[] = [];

  const accounts = {
    save: async () => {},
    update: async () => {},
    findByEmail: async () => foundAccount,
    findById: async () => foundAccount,
    findByEmailForUpdate: async (
      received: TransactionContext,
      email: string,
    ) => {
      expect(received).toBe(transaction);
      calls.push(`lock-account:${email}`);
      return foundAccount;
    },
    findByIdForUpdate: async () => foundAccount,
  } as unknown as AccountRepository;

  const lockouts = {
    find: async (email: string) => {
      calls.push(`find-lockout:${email}`);
      return foundLockout;
    },
    findForUpdate: async (received: TransactionContext, email: string) => {
      expect(received).toBe(transaction);
      calls.push('lock-lockout');
      return foundLockout?.email === email ? foundLockout : null;
    },
    save: async (received: TransactionContext, value: SignInLockoutEntity) => {
      expect(received).toBe(transaction);
      calls.push('save-lockout');
      lockoutsWritten.push(value);
    },
  } as unknown as SignInLockoutRepository;

  const verify = vi.fn(async (plaintext: string, hash: string) => {
    calls.push(`verify:${plaintext}`);
    return hash === 'stored-hash' && plaintext === PASSWORD;
  });
  const dummyHash = vi.fn(async () => {
    calls.push('hash-dummy');
    return 'dummy-hash';
  });
  const passwords = {
    hash: dummyHash,
    verify,
  } as unknown as BcryptPasswordHasher;

  const sessions = {
    save: async () => {},
    update: async (received: TransactionContext, value: SessionEntity) => {
      expect(received).toBe(transaction);
      calls.push(`session-update:${value.revokedReason ?? 'active'}`);
    },
    findById: async () => foundSession,
    findByIdForUpdate: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`lock-session:${id}`);
      return foundSession;
    },
    revokeByAccount: async () => [],
  } as unknown as SessionRepository;

  const refreshTokens = {
    save: async () => {},
    update: async (received: TransactionContext, value: RefreshTokenEntity) => {
      expect(received).toBe(transaction);
      calls.push(`token-update:${value.status}`);
      tokensUpdated.push(value);
    },
    findByHash: async () => foundToken,
    findByHashForUpdate: async (
      received: TransactionContext,
      hashValue: string,
    ) => {
      expect(received).toBe(transaction);
      calls.push(`lock-token:${hashValue}`);
      return foundToken;
    },
    revokeBySession: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-tokens:${id}`);
    },
    revokeByAccount: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-account-tokens:${id}`);
    },
  } as unknown as RefreshTokenRepository;

  const deviceCredentials = {
    revokeBySession: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-devices:${id}`);
    },
    revokeByAccount: async (received: TransactionContext, id: string) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-account-devices:${id}`);
    },
  } as unknown as DeviceCredentialRepository;

  const hash = vi.fn(() => HASH);
  const tokenHasher = {
    generate: () => 'generated',
    hash,
    seal: (value: unknown) => `sealed:${JSON.stringify(value)}`,
    open: vi.fn(() => replayValue),
  } as unknown as NodeRefreshTokenHasher;

  const issue = vi.fn(async () => ({
    tokens: TOKENS,
    session: {} as never,
    refreshToken: {} as never,
    accessExpiresAt: EXPIRES_AT,
  }));
  const rotate = vi.fn(async () => ({
    tokens: NEW_TOKENS,
    refreshToken: token({ id: 'successor' }),
    accessExpiresAt: EXPIRES_AT,
  }));
  const replay = vi.fn(() => replayValue);
  const issuer = { issue, rotate, replay } as unknown as SessionIssuer;

  const evaluate = vi.fn(async () => ({
    allowed: false,
    secondsRemaining: 90,
  }));
  const ratePolicy = {
    evaluate,
    nextAllowedSeconds: () => 120,
  } as unknown as VerificationRatePolicy;

  const outbox: OutboxPort = {
    append: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push('outbox');
      events.push(value as SessionRevokedEvent);
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
    service: new SessionsService(
      unitOfWork,
      accounts,
      passwords,
      lockouts,
      sessions,
      refreshTokens,
      deviceCredentials,
      tokenHasher,
      issuer,
      ratePolicy,
      outbox,
    ),
    calls,
    transaction,
    savedLockouts: () => lockoutsWritten,
    updatedTokens: () => tokensUpdated,
    events: () => events,
    issue,
    rotate,
    replay,
    verify,
    hash,
    dummyHash,
    evaluate,
    givenAccount: (value) => {
      foundAccount = value;
    },
    givenLockout: (value) => {
      foundLockout = value;
    },
    givenSession: (value) => {
      foundSession = value;
    },
    givenToken: (value) => {
      foundToken = value;
    },
    givenReplay: (value) => {
      replayValue = value;
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

function signInCommand(overrides: Partial<SignInCommand> = {}): SignInCommand {
  return {
    email: ' User@Example.COM ',
    password: PASSWORD,
    deviceId: 'device-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

function refreshCommand(
  overrides: Partial<RefreshCommand> = {},
): RefreshCommand {
  return {
    refreshToken: RAW_TOKEN,
    correlationId: 'corr-1',
    ...overrides,
  };
}

function signOutCommand(
  overrides: Partial<SignOutCommand> = {},
): SignOutCommand {
  return {
    refreshToken: RAW_TOKEN,
    sessionId: 'session-1',
    jti: 'jti-1',
    accessTokenExpiresAt: EXPIRES_AT.toISOString(),
    accountId: 'account-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('SessionsService (BR-04, BR-05, BR-06, BR-07, BR-09)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issues a token pair for a verified account and resets the counter', async () => {
    const h = harness();
    h.givenLockout(lockout(3));

    const result: SignInResponseDto = await h.service.signIn(signInCommand());

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

    const result = await h.service.signIn(signInCommand());

    expect(result).toEqual({
      verificationRequired: true,
      maskedEmail: 'u***@example.com',
      secondsRemaining: 90,
      tokens: null,
    });
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.evaluate).toHaveBeenCalledWith('user@example.com', 'sign_up', NOW);
  });

  it('answers an unknown address and a wrong password with the same code', async () => {
    const unknown = harness();
    unknown.givenAccount(null);
    const unknownError = await errorOf(unknown.service.signIn(signInCommand()));

    const wrong = harness();
    const wrongError = await errorOf(
      wrong.service.signIn(signInCommand({ password: 'Wr0ng!Pass' })),
    );

    expect(unknownError.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(wrongError.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(unknown.savedLockouts()[0].failedCount).toBe(1);
    expect(wrong.savedLockouts()[0].failedCount).toBe(1);
    // The unknown address still pays for one bcrypt comparison.
    expect(unknown.dummyHash).toHaveBeenCalledOnce();
    expect(unknown.verify).toHaveBeenCalledWith(PASSWORD, 'dummy-hash');
  });

  it('hashes the dummy password only once across probes', async () => {
    const h = harness();
    h.givenAccount(null);

    await errorOf(h.service.signIn(signInCommand()));
    await errorOf(
      h.service.signIn(signInCommand({ email: 'other@example.com' })),
    );

    expect(h.dummyHash).toHaveBeenCalledOnce();
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it('locks after the configured number of failures with a retry hint', async () => {
    const h = harness();
    h.givenLockout(lockout(SIGN_IN_LOCK_THRESHOLD - 1));

    const error = await errorOf(
      h.service.signIn(signInCommand({ password: 'Wr0ng!Pass' })),
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
      lockout(SIGN_IN_LOCK_THRESHOLD, new Date(NOW.getTime() + 60_000)),
    );

    const error = await errorOf(h.service.signIn(signInCommand()));

    expect(error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(error.retryAfterSeconds).toBe(60);
    expect(h.calls).toEqual(['find-lockout:user@example.com']);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('checks the password before revealing that an account is disabled', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    expect(
      (
        await errorOf(
          h.service.signIn(signInCommand({ password: 'Wr0ng!Pass' })),
        )
      ).code,
    ).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect((await errorOf(h.service.signIn(signInCommand()))).code).toBe(
      ErrorCode.ACCOUNT_DISABLED,
    );
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('does not issue a session when the stored hash is missing', async () => {
    const h = harness();
    h.givenAccount(account('active', ''));

    const error = await errorOf(h.service.signIn(signInCommand()));

    expect(error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('hashes the presented token and rotates an active pair', async () => {
    const h = harness();

    await expect(h.service.refresh(refreshCommand())).resolves.toEqual(
      NEW_TOKENS,
    );

    expect(h.hash).toHaveBeenCalledWith(RAW_TOKEN);
    expect(h.calls).toEqual([
      'begin',
      `lock-token:${HASH}`,
      'lock-session:session-1',
      'commit',
    ]);
    expect(h.rotate).toHaveBeenCalledWith(
      h.transaction,
      expect.objectContaining({ id: 'account-1' }),
      expect.objectContaining({ id: 'session-1' }),
      expect.objectContaining({ id: 'token-1' }),
      NOW,
    );
  });

  it('rejects an unknown token without touching the session', async () => {
    const h = harness();
    h.givenToken(null);

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.calls).toEqual(['begin', `lock-token:${HASH}`, 'commit']);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a revoked or missing session', async () => {
    const revoked = harness();
    revoked.givenSession(
      session({ revokedAt: NOW, revokedReason: 'sign_out' }),
    );
    expect(
      (await errorOf(revoked.service.refresh(refreshCommand()))).code,
    ).toBe(ErrorCode.SESSION_REVOKED);

    const missing = harness();
    missing.givenSession(null);
    expect(
      (await errorOf(missing.service.refresh(refreshCommand()))).code,
    ).toBe(ErrorCode.SESSION_REVOKED);
  });

  it('rejects a token whose account no longer exists', async () => {
    const h = harness();
    h.givenAccount(null);

    expect((await errorOf(h.service.refresh(refreshCommand()))).code).toBe(
      ErrorCode.INVALID_REFRESH_TOKEN,
    );
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('revokes every credential when the account is disabled', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(h.calls).toContain('session-update:admin');
    expect(h.calls).toContain('revoke-tokens:session-1');
    expect(h.calls).toContain('revoke-devices:session-1');
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('refuses an active token in an expired session', async () => {
    const h = harness();
    h.givenSession(session({ expiresAt: new Date(NOW.getTime() - 1_000) }));

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.SESSION_REVOKED);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('replays the sealed successor inside the grace window', async () => {
    const h = harness();
    h.givenToken(
      token({
        status: 'rotated',
        rotatedAt: NOW,
        replacedById: 'successor',
        gracePayload: 'sealed',
        graceExpiresAt: new Date(NOW.getTime() + 5_000),
      }),
    );

    await expect(h.service.refresh(refreshCommand())).resolves.toEqual(
      NEW_TOKENS,
    );

    expect(h.replay).toHaveBeenCalledOnce();
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a grace replay that cannot be unsealed', async () => {
    const h = harness();
    h.givenReplay(null);
    h.givenToken(
      token({
        status: 'rotated',
        rotatedAt: NOW,
        replacedById: 'successor',
        gracePayload: 'tampered',
        graceExpiresAt: new Date(NOW.getTime() + 5_000),
      }),
    );

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
  });

  it('destroys the session when a rotated token is replayed after the grace window', async () => {
    const h = harness();
    h.givenToken(
      token({
        status: 'rotated',
        rotatedAt: new Date(NOW.getTime() - 60_000),
        replacedById: 'successor',
        gracePayload: null,
      }),
    );

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.REFRESH_TOKEN_REUSE_DETECTED);
    expect(h.calls).toEqual([
      'begin',
      `lock-token:${HASH}`,
      'lock-session:session-1',
      'session-update:refresh_reuse',
      'revoke-tokens:session-1',
      'revoke-devices:session-1',
      'outbox',
      'commit',
    ]);
    expect(h.events()[0]).toMatchObject({
      type: 'identity.session.revoked',
      correlationId: 'corr-1',
      occurredAt: NOW.toISOString(),
      payload: {
        accountId: 'account-1',
        sessionId: 'session-1',
        jti: '',
        reason: 'refresh_reuse',
        revokedAt: NOW.toISOString(),
      },
    });
  });

  it('refuses a revoked token without revoking the session again', async () => {
    const h = harness();
    h.givenToken(token({ status: 'revoked', revokedAt: NOW }));

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.calls).not.toContain('revoke-tokens:session-1');
  });

  it('refuses an expired token', async () => {
    const h = harness();
    h.givenToken(token({ expiresAt: new Date(NOW.getTime() - 1) }));

    const error = await errorOf(h.service.refresh(refreshCommand()));

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('revokes the session, its refresh tokens and devices, then publishes', async () => {
    const h = harness();

    await expect(h.service.signOut(signOutCommand())).resolves.toEqual({
      revoked: true,
    });

    expect(h.calls).toEqual([
      'begin',
      'lock-session:session-1',
      'session-update:sign_out',
      'revoke-tokens:session-1',
      `lock-token:${HASH}`,
      'token-update:revoked',
      'revoke-devices:session-1',
      'outbox',
      'commit',
    ]);
    expect(h.updatedTokens()[0].revokedAt).toEqual(NOW);
    expect(h.events()[0]).toMatchObject({
      type: 'identity.session.revoked',
      correlationId: 'corr-1',
      payload: {
        accountId: 'account-1',
        sessionId: 'session-1',
        jti: 'jti-1',
        expiresAt: EXPIRES_AT.toISOString(),
        reason: 'sign_out',
        revokedAt: NOW.toISOString(),
      },
    });
  });

  it('is idempotent for an already-revoked session', async () => {
    const h = harness();
    h.givenSession(session({ revokedAt: NOW, revokedReason: 'sign_out' }));

    await h.service.signOut(signOutCommand());

    expect(h.calls).not.toContain('session-update:sign_out');
    expect(h.calls).toContain('revoke-devices:session-1');
    expect(h.events()).toHaveLength(1);
  });

  it('does nothing for a session that belongs to another account', async () => {
    const h = harness();
    h.givenSession(session({ accountId: 'someone-else' }));

    await expect(h.service.signOut(signOutCommand())).resolves.toEqual({
      revoked: true,
    });

    expect(h.calls).toEqual(['begin', 'lock-session:session-1', 'commit']);
    expect(h.events()).toEqual([]);
  });

  it('does nothing for a session that does not exist', async () => {
    const h = harness();
    h.givenSession(null);

    await h.service.signOut(signOutCommand());

    expect(h.events()).toEqual([]);
    expect(h.updatedTokens()).toEqual([]);
  });

  it('does not revoke a token that belongs to another session', async () => {
    const h = harness();
    h.givenToken(token({ sessionId: 'another-session' }));

    await h.service.signOut(signOutCommand());

    expect(h.updatedTokens()).toEqual([]);
  });
});
