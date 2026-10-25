import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { SessionRevokedPayloadV1 } from '@app/contracts';
import { RedisClientService } from '@app/common';
import { RevocationStore } from './revocation.store.js';

const NOW = new Date('2026-10-24T10:00:00.000Z');
const NOW_MS = NOW.getTime();
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

interface Pipeline {
  set: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

interface FakeRedis {
  service: RedisClientService;
  mget: ReturnType<typeof vi.fn>;
  pipeline: Pipeline;
  available: boolean;
}

function fakeRedis(
  options: {
    available?: boolean;
    mget?: () => Promise<(string | null)[]>;
    exec?: () => Promise<unknown>;
  } = {},
): FakeRedis {
  const pipeline: Pipeline = {
    set: vi.fn(),
    exec: vi.fn(options.exec ?? (async () => [])),
  };
  pipeline.set.mockReturnValue(pipeline);
  const state: FakeRedis = {
    service: undefined as unknown as RedisClientService,
    mget: vi.fn(options.mget ?? (async () => [null, null, null])),
    pipeline,
    available: options.available ?? true,
  };
  const client = {
    mget: state.mget,
    pipeline: vi.fn(() => pipeline),
  };
  state.service = {
    isAvailable: () => state.available,
    getClient: () => client,
  } as unknown as RedisClientService;
  return state;
}

function payload(
  overrides: Partial<SessionRevokedPayloadV1> = {},
): SessionRevokedPayloadV1 {
  return {
    accountId: 'account-1',
    sessionId: 'session-1',
    jti: 'jti-1',
    expiresAt: new Date(NOW_MS + 900_000).toISOString(),
    reason: 'sign_out',
    revokedAt: NOW.toISOString(),
    ...overrides,
  };
}

function subject(
  overrides: Partial<{
    jti: string;
    sid: string;
    sub: string;
    iat: number;
  }> = {},
): { jti: string; sid: string; sub: string; iat: number } {
  return {
    jti: 'jti-1',
    sid: 'session-1',
    sub: 'account-1',
    iat: NOW_SECONDS,
    ...overrides,
  };
}

describe('RevocationStore (F6c, BR-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes session and jti markers to memory and Redis with one TTL', async () => {
    const redis = fakeRedis();

    await new RevocationStore(redis.service).revoke(payload());

    expect(redis.pipeline.set).toHaveBeenCalledWith(
      'auth:revoked:sid:session-1',
      '1',
      'PX',
      900_000,
    );
    expect(redis.pipeline.set).toHaveBeenCalledWith(
      'auth:revoked:jti:jti-1',
      '1',
      'PX',
      900_000,
    );
    expect(redis.pipeline.exec).toHaveBeenCalledOnce();
  });

  it('keeps a revoked token revoked when Redis is already down', async () => {
    const redis = fakeRedis();
    const store = new RevocationStore(redis.service);
    await store.revoke(payload());

    redis.available = false;

    await expect(store.isRevoked(subject())).resolves.toBe(true);
  });

  it('fails open when Redis is down and nothing is in memory', async () => {
    const redis = fakeRedis({ available: false });
    const store = new RevocationStore(redis.service);

    await expect(store.isRevoked(subject())).resolves.toBe(false);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('reads markers from Redis for a fresh instance', async () => {
    const redis = fakeRedis({
      mget: async () => ['1', null, null],
    });
    const store = new RevocationStore(redis.service);

    await expect(store.isRevoked(subject())).resolves.toBe(true);
    expect(redis.mget).toHaveBeenCalledWith(
      'auth:revoked:jti:jti-1',
      'auth:revoked:sid:session-1',
      'auth:revoked:account:account-1',
    );
  });

  it('revokes every token minted at or before an account-wide reset', async () => {
    const redis = fakeRedis();
    const store = new RevocationStore(redis.service);
    await store.revoke(payload({ allSessions: true, reason: 'password_reset' }));

    await expect(
      store.isRevoked(subject({ iat: NOW_SECONDS - 5 })),
    ).resolves.toBe(true);
    await expect(
      store.isRevoked(subject({ iat: NOW_SECONDS + 5, jti: 'later', sid: 'later' })),
    ).resolves.toBe(false);
  });

  it('honours an account marker written by another instance', async () => {
    const redis = fakeRedis({
      mget: async () => [null, null, String(NOW_MS)],
    });
    const store = new RevocationStore(redis.service);

    await expect(
      store.isRevoked(subject({ iat: NOW_SECONDS - 1 })),
    ).resolves.toBe(true);
    await expect(
      store.isRevoked(subject({ iat: NOW_SECONDS + 1, jti: 'later', sid: 'later' })),
    ).resolves.toBe(false);
  });

  it('ignores an unreadable Redis account marker instead of revoking everyone', async () => {
    const redis = fakeRedis({
      mget: async () => [null, null, 'not-a-number'],
    });
    const store = new RevocationStore(redis.service);

    await expect(store.isRevoked(subject())).resolves.toBe(false);
  });

  it('prunes markers once the token could no longer be valid', async () => {
    const redis = fakeRedis();
    const store = new RevocationStore(redis.service);
    await store.revoke(
      payload({ expiresAt: new Date(NOW_MS + 1_000).toISOString() }),
    );

    vi.setSystemTime(NOW_MS + 1_001);

    await expect(store.isRevoked(subject())).resolves.toBe(false);
  });

  it('does nothing for a marker whose access token has already expired', async () => {
    const redis = fakeRedis();
    const store = new RevocationStore(redis.service);

    await store.revoke(
      payload({ expiresAt: new Date(NOW_MS - 1_000).toISOString() }),
    );

    expect(redis.pipeline.set).not.toHaveBeenCalled();
    await expect(store.isRevoked(subject())).resolves.toBe(false);
  });

  it('still protects memory when Redis writes fail', async () => {
    const redis = fakeRedis({
      exec: async () => {
        throw new Error('redis write failed');
      },
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const store = new RevocationStore(redis.service);

    await expect(store.revoke(payload())).resolves.toBeUndefined();
    await expect(store.isRevoked(subject())).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not persist revocation markers'),
    );
  });

  it('fails open and warns when the Redis lookup throws', async () => {
    const redis = fakeRedis({
      mget: async () => {
        throw new Error('connection reset');
      },
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const store = new RevocationStore(redis.service);

    await expect(store.isRevoked(subject())).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Revocation lookup failed'),
    );
  });
});
