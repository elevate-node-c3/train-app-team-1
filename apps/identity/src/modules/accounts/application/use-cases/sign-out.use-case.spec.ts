import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRevokedEvent } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { SignOutUseCase } from './sign-out.use-case.js';
import type { DeviceCredentialRepositoryPort } from '../ports/device-credential.repository.port.js';
import type { RefreshTokenRepositoryPort } from '../ports/refresh-token.repository.port.js';
import type { RefreshTokenHasherPort } from '../ports/refresh-token-hasher.port.js';
import type { SessionRepositoryPort } from '../ports/session.repository.port.js';
import { RefreshToken } from '../../domain/refresh-token.js';
import { Session } from '../../domain/session.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const RAW_TOKEN = 'raw-refresh-token';
const HASH = `hash:${RAW_TOKEN}`;
const EXPIRES_AT = new Date(NOW.getTime() + 900_000);

function session(
  overrides: Partial<Parameters<typeof Session.restore>[0]> = {},
): Session {
  return Session.restore({
    id: 'session-1',
    accountId: 'account-1',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
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
  useCase: SignOutUseCase;
  calls: string[];
  transaction: TransactionContext;
  events(): SessionRevokedEvent[];
  updatedTokens(): RefreshToken[];
  givenSession(value: Session | null): void;
  givenToken(value: RefreshToken | null): void;
}

function harness(): Harness {
  const transaction: TransactionContext = { driver: 'fake' };
  const calls: string[] = [];
  let foundSession: Session | null = session();
  let foundToken: RefreshToken | null = token();
  const events: SessionRevokedEvent[] = [];
  const tokensUpdated: RefreshToken[] = [];

  const sessions: SessionRepositoryPort = {
    save: async () => {},
    update: async (received, value) => {
      expect(received).toBe(transaction);
      calls.push(`session-update:${value.revokedReason}`);
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
      tokensUpdated.push(value);
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
    revokeByAccount: async () => {},
  };
  const deviceCredentials: DeviceCredentialRepositoryPort = {
    revokeBySession: async (received, id) => {
      expect(received).toBe(transaction);
      calls.push(`revoke-devices:${id}`);
    },
    revokeByAccount: async () => {},
  };
  const tokenHasher: RefreshTokenHasherPort = {
    generate: () => '',
    hash: (value) => `hash:${value}`,
    seal: () => '',
    open: () => ({}),
  };
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
    useCase: new SignOutUseCase(
      unitOfWork,
      sessions,
      refreshTokens,
      deviceCredentials,
      tokenHasher,
      outbox,
    ),
    calls,
    transaction,
    events: () => events,
    updatedTokens: () => tokensUpdated,
    givenSession: (value) => {
      foundSession = value;
    },
    givenToken: (value) => {
      foundToken = value;
    },
  };
}

function command() {
  return {
    refreshToken: RAW_TOKEN,
    sessionId: 'session-1',
    jti: 'jti-1',
    accessTokenExpiresAt: EXPIRES_AT.toISOString(),
    accountId: 'account-1',
    correlationId: 'corr-1',
  };
}

describe('SignOutUseCase (BR-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('revokes the session, its refresh tokens and devices, then publishes', async () => {
    const h = harness();

    await expect(h.useCase.execute(command())).resolves.toEqual({
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

    await h.useCase.execute(command());

    expect(h.calls).not.toContain('session-update:sign_out');
    expect(h.calls).toContain('revoke-devices:session-1');
    expect(h.events()).toHaveLength(1);
  });

  it('does nothing for a session that belongs to another account', async () => {
    const h = harness();
    h.givenSession(session({ accountId: 'someone-else' }));

    await expect(h.useCase.execute(command())).resolves.toEqual({
      revoked: true,
    });

    expect(h.calls).toEqual([
      'begin',
      'lock-session:session-1',
      'commit',
    ]);
    expect(h.events()).toEqual([]);
  });

  it('does nothing for a session that does not exist', async () => {
    const h = harness();
    h.givenSession(null);

    await h.useCase.execute(command());

    expect(h.events()).toEqual([]);
    expect(h.updatedTokens()).toEqual([]);
  });

  it('does not revoke a token that belongs to another session', async () => {
    const h = harness();
    h.givenToken(token({ sessionId: 'another-session' }));

    await h.useCase.execute(command());

    expect(h.updatedTokens()).toEqual([]);
  });
});
