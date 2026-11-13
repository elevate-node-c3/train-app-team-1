import { CacheAsideService } from '../../libs/common/src/cache/cache-aside.service.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
// The named Redis export is the constructor; the default resolves to a namespace.
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertReachable } from './support/catalog-database.js';

/**
 * Real Redis checks the `set(key, value, 'EX', ttl)` signature and expiry
 * that the unit spec's fake client cannot verify.
 */
const REDIS_URL = `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

describe('cache-aside against Redis', () => {
  let redis: RedisClientService;
  let cache: CacheAsideService;
  let probe: Redis;

  beforeAll(async () => {
    // Fail fast instead of waiting for retries and reporting skipped tests.
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
    // afterAll still runs if beforeAll fails; keep cleanup from hiding that error.
    if (probe !== undefined) {
      await probe.del('int:cache:trip');
      probe.disconnect();
    }
    if (redis !== undefined) await redis.onModuleDestroy();
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

  // TTL bounds how long stale lists survive.
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
    // Older deploys or other writers may leave values this caller cannot parse.
    await probe.set('int:cache:trip', 'plain text, not json');

    await expect(cache.get('int:cache:trip')).resolves.toBeNull();
  });
});
