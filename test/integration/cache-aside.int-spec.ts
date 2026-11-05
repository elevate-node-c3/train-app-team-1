import { CacheAsideService } from '../../libs/common/src/cache/cache-aside.service.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
// Named, as `redis-client.service.ts` imports it: the default export is a
// namespace under this module resolution, not the constructor.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertReachable } from './support/catalog-database.js';

/**
 * The cache against a real Redis.
 *
 * The unit spec uses a fake client, so it proves the branching but not that
 * `set(key, value, 'EX', ttl)` is a call ioredis actually accepts, nor that a
 * TTL is really applied. Both are the kind of thing a fake agrees with and a
 * server does not.
 */
const REDIS_URL = `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

describe('cache-aside against Redis', () => {
  let redis: RedisClientService;
  let cache: CacheAsideService;
  let probe: Redis;

  beforeAll(async () => {
    // Same reason as the database probe: ioredis retries for half a minute
    // before giving up, and the tests then report as skipped rather than as
    // "start Redis".
    const url = new URL(REDIS_URL);
    await assertReachable('Redis', url.hostname, Number(url.port || 6379));

    process.env.REDIS_URL = REDIS_URL;
    redis = new RedisClientService();
    await redis.onModuleInit();
    cache = new CacheAsideService(redis);

    // A second connection, to observe what the service wrote.
    probe = new Redis(REDIS_URL);
    await probe.del('int:cache:trip');
  });

  afterAll(async () => {
    await probe.del('int:cache:trip');
    probe.disconnect();
    await redis.onModuleDestroy();
  });

  it('is actually connected, so the rest of this file means something', () => {
    expect(redis.isAvailable()).toBe(true);
  });

  it('round-trips a value', async () => {
    await cache.set('int:cache:trip', { tripId: 'a', fare: 15500 }, 300);

    await expect(
      cache.get<{ tripId: string; fare: number }>('int:cache:trip'),
    ).resolves.toEqual({ tripId: 'a', fare: 15500 });
  });

  // The TTL is the only thing bounding how long a stale list survives, so a
  // silently-ignored expiry argument would matter.
  it('applies the ttl it was given', async () => {
    await cache.set('int:cache:trip', { tripId: 'a' }, 120);

    const ttl = await probe.ttl('int:cache:trip');

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('reports a miss for a key nobody wrote', async () => {
    await expect(cache.get('int:cache:absent')).resolves.toBeNull();
  });

  it('treats a value written by something else as a miss', async () => {
    // Exactly what an older deploy's payload, or an unrelated writer, looks
    // like: present, readable, and not JSON this caller can use.
    await probe.set('int:cache:trip', 'plain text, not json');

    await expect(cache.get('int:cache:trip')).resolves.toBeNull();
  });
});
