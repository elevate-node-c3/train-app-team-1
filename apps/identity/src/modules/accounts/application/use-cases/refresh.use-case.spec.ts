import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  type RefreshResponseDto,
  type SessionRevokedEvent,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { RefreshUseCase } from './refresh.use-case.js';
import { AuthError } from '../auth-error.js';
import type { AccountRepositoryPort } from '../ports/account.repository.port.js';
import type { DeviceCredentialRepositoryPort } from '../ports/device-credential.repository.port.js';
import type { RefreshTokenRepositoryPort } from '../ports/refresh-token.repository.port.js';
import type { RefreshTokenHasherPort } from '../ports/refresh-token-hasher.port.js';
import type { SessionRepositoryPort } from '../ports/session.repository.port.js';
import type { SessionIssuer } from '../services/session.issuer.js';
import { Account } from '../../domain/account.js';
import { RefreshToken } from '../../domain/refresh-token.js';
import { Session } from '../../domain/session.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const RAW_TOKEN = 'raw-refresh-token';
const HASH = `hash:${RAW_TOKEN}`;
const TOKENS: RefreshResponseDto = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  tokenType: 'Bearer',
  accessExpiresIn: TOKEN_DEFAULTS.accessTtlSeconds,
  refreshExpiresIn: TOKEN_DEFAULTS.refreshTtlSeconds,
};

function account(status: 'active' | 'disabled' = 'active'): Account {
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

function session(
  overrides: Partial<Parameters<typeof Session.restore>[0]> = {},
): Session {
  return Session.restore({
    id: 'session-1',
    accountId: 'account-1',
    createdAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
}

function token(
  overrides: Partial<Parameters<typeof RefreshToken.restore>[0]> = {},
): RefreshToken {
  return RefreshToken.restore({
    id: 'token-1',
    sessionId: 'session-1',
    tokenHash: HASH,
    status: 'active',
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  });
}

interface Harness {
  useCase: RefreshUseCase;
  calls: string[];
  transaction: TransactionContext;
  events(): SessionRevokedEvent[];
  rotate: ReturnType<typeof vi.fn>;
  replay: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  hash: ReturnType<typeof vi.fn>;
  givenToken(value: RefreshToken | null): void;
  givenSession(value: Session | null): void;
  givenAccount(value: Account | null): void;
  givenReplay(value: RefreshResponseDto | null): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundToken: RefreshToken | null = token();
  let foundSession: Session | null = session();
  let foundAccount: Account | null = account();
  let replayValue: RefreshResponseDto | null = TOKENS;
  const events: SessionRevokedEvent[] = [];

  const accounts: AccountRepositoryPort = {
    save: async () => {},
    update: async () => {},
    findByEmail: async () => foundAccount,
    findById: async () => foundAccount,
    findByEmailForUpdate: async () => foundAccount,
    findByIdForUpdate: async () => foundAccount,
  };
  const sessions: SessionRepositoryPort = {
    save: async () => {},
    update: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push(`session-update:${value.revokedReason ?? 'active'}`);
    },
    findById: async () => foundSession,
    findByIdForUpdate: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`lock-session:${id}`);
      return foundSession;
    },
    revokeByAccount: async () => [],
  };
  const refreshTokens: RefreshTokenRepositoryPort = {
    save: async () => {},
    update: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push(`token-update:${value.status}`);
    },
    findByHash: async () => foundToken,
    findByHashForUpdate: async (received, hash) => {
      expect(received).toBe(transaction);
      calls.push(`lock-token:${hash}`);
      return foundToken;
    },
    revokeBySession: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-tokens:${id}`);
    },
    revokeByAccount: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-account-tokens:${id}`);
    },
  };
  const deviceCredentials: DeviceCredentialRepositoryPort = {
    revokeBySession: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-devices:${id}`);
    },
    revokeByAccount: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-account-devices:${id}`);
    },
  };
  const hash = vi.fn(() => HASH);
  const open = vi.fn(() => replayValue);
  const tokenHasher: RefreshTokenHasherPort = {
    generate: () => 'generated',
    hash,
    seal: (value) => `sealed:${JSON.stringify(value)}`,
    open,
  };
  const rotate = vi.fn(async () => ({
    tokens: TOKENS,
    refreshToken: token({ id: 'successor' }),
    accessExpiresAt: new Date(NOW.getTime() + 900_000),
  }));
  const replay = vi.fn(() => replayValue);
  const issuer = { rotate, replay } as unknown as SessionIssuer;
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
    useCase: new RefreshUseCase(
      unitOfWork,
      accounts,
      sessions,
      refreshTokens,
      deviceCredentials,
      tokenHasher,
      issuer,
      outbox,
    ),
    calls,
    transaction,
    events: () => events,
    rotate,
    replay,
    open,
    hash,
    givenToken: (value) => {
      foundToken = value;
    },
    givenSession: (value) => {
      foundSession = value;
    },
    givenAccount: (value) => {
      foundAccount = value;
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
  throw new Error('expected the use case to reject');
}

describe('RefreshUseCase (BR-06, BR-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hashes the presented token and rotates an active pair', async () => {
    const h = harness();

    await expect(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    ).resolves.toEqual(TOKENS);

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

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.calls).toEqual(['begin', `lock-token:${HASH}`, 'commit']);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('rejects a revoked or missing session', async () => {
    const revoked = harness();
    revoked.givenSession(session({ revokedAt: NOW, revokedReason: 'sign_out' }));
    expect(
      (await errorOf(
        revoked.useCase.execute({
          refreshToken: RAW_TOKEN,
          correlationId: 'corr-1',
        }),
      )).code,
    ).toBe(ErrorCode.SESSION_REVOKED);

    const missing = harness();
    missing.givenSession(null);
    expect(
      (await errorOf(
        missing.useCase.execute({
          refreshToken: RAW_TOKEN,
          correlationId: 'corr-1',
        }),
      )).code,
    ).toBe(ErrorCode.SESSION_REVOKED);
  });

  it('rejects a token whose account no longer exists', async () => {
    const h = harness();
    h.givenAccount(null);

    expect(
      (await errorOf(
        h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
      )).code,
    ).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('revokes every credential when the account is disabled', async () => {
    const h = harness();
    h.givenAccount(account('disabled'));

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

    expect(error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(h.calls).toContain('session-update:admin');
    expect(h.calls).toContain('revoke-tokens:session-1');
    expect(h.calls).toContain('revoke-devices:session-1');
    expect(h.rotate).not.toHaveBeenCalled();
  });

  it('refuses an active token in an expired session', async () => {
    const h = harness();
    h.givenSession(
      session({ expiresAt: new Date(NOW.getTime() - 1_000) }),
    );

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

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

    await expect(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    ).resolves.toEqual(TOKENS);

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

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

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

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

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

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.calls).not.toContain('revoke-tokens:session-1');
  });

  it('refuses an expired token', async () => {
    const h = harness();
    h.givenToken(token({ expiresAt: new Date(NOW.getTime() - 1) }));

    const error = await errorOf(
      h.useCase.execute({ refreshToken: RAW_TOKEN, correlationId: 'corr-1' }),
    );

    expect(error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(h.rotate).not.toHaveBeenCalled();
  });
});
