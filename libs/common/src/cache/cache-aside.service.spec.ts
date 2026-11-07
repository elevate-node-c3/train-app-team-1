import { describe, expect, it, vi } from 'vitest';

import { CacheAsideService } from './cache-aside.service.js';
import type { RedisClientService } from './redis-client.service.js';

interface FakeClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

function withRedis(client: FakeClient | null): {
  cache: CacheAsideService;
  client: FakeClient | null;
} {
  const redis = {
    isAvailable: () => client !== null,
    getClient: () => client,
  } as unknown as RedisClientService;

  return { cache: new CacheAsideService(redis), client };
}

function fakeClient(stored: string | null = null): FakeClient {
  return {
    get: vi.fn().mockResolvedValue(stored),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

describe('cache-aside', () => {
  it('returns null on a miss', async () => {
    const { cache } = withRedis(fakeClient(null));

    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('returns the decoded value on a hit', async () => {
    const { cache } = withRedis(fakeClient('{"a":1}'));

    await expect(cache.get<{ a: number }>('k')).resolves.toEqual({ a: 1 });
  });

  it('stores JSON with the ttl it was given', async () => {
    const { cache, client } = withRedis(fakeClient());

    await cache.set('k', { a: 1 }, 300);

    expect(client!.set).toHaveBeenCalledWith('k', '{"a":1}', 'EX', 300);
  });

  it('deletes a key', async () => {
    const { cache, client } = withRedis(fakeClient());

    await cache.del('k');

    expect(client!.del).toHaveBeenCalledWith('k');
  });

  // Degrade, never fail: a cache outage must not turn search into an error.
  // The same contract RateLimitStore keeps.
  describe('when Redis is unavailable', () => {
    it('reports a miss instead of throwing', async () => {
      const { cache } = withRedis(null);

      await expect(cache.get('k')).resolves.toBeNull();
    });

    it('accepts a write and drops it', async () => {
      const { cache } = withRedis(null);

      await expect(cache.set('k', { a: 1 }, 300)).resolves.toBeUndefined();
    });

    it('accepts a delete and drops it', async () => {
      const { cache } = withRedis(null);

      await expect(cache.del('k')).resolves.toBeUndefined();
    });
  });

  describe('when Redis misbehaves', () => {
    it('treats a read error as a miss', async () => {
      const client = fakeClient();
      client.get.mockRejectedValue(new Error('connection reset'));
      const { cache } = withRedis(client);

      await expect(cache.get('k')).resolves.toBeNull();
    });

    it('swallows a write error', async () => {
      const client = fakeClient();
      client.set.mockRejectedValue(new Error('OOM'));
      const { cache } = withRedis(client);

      await expect(cache.set('k', { a: 1 }, 300)).resolves.toBeUndefined();
    });

    it('swallows a delete error', async () => {
      const client = fakeClient();
      client.del.mockRejectedValue(new Error('connection reset'));
      const { cache } = withRedis(client);

      await expect(cache.del('k')).resolves.toBeUndefined();
    });

    // A value written by an older deploy, or a key someone else set, parses as
    // JSON but is not what this caller expects. Garbage in the cache must not
    // become garbage in a response.
    it('treats undecodable JSON as a miss', async () => {
      const { cache } = withRedis(fakeClient('not json at all'));

      await expect(cache.get('k')).resolves.toBeNull();
    });
  });
});
