import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CacheAsideService } from '../../libs/common/src/cache/cache-aside.service.js';
import { CacheMetrics } from '../../libs/common/src/cache/cache-metrics.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
import { assertReachable } from './support/catalog-database.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

describe('Distributed Stampede Guard (§2.3 rule 3)', () => {
  let redis: RedisClientService;
  let metrics: CacheMetrics;
  let cache: CacheAsideService;

  beforeAll(async () => {
    const url = new URL(REDIS_URL);
    await assertReachable('Redis', url.hostname, Number(url.port || 6379));

    process.env.REDIS_URL = REDIS_URL;
    redis = new RedisClientService();
    await redis.onModuleInit();

    metrics = new CacheMetrics();
    cache = new CacheAsideService(redis, metrics);
  });

  afterAll(async () => {
    if (redis !== undefined) await redis.onModuleDestroy();
  });

  it('coalesces 200 concurrent requests on a cold key into exactly 1 rebuild', async () => {
    const coldKey = `int:stampede:cold-${Date.now()}`;
    let dbQueryCount = 0;

    const loader = vi.fn(async () => {
      dbQueryCount++;
      // Keep requests overlapping while the loader waits.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        trips: [{ id: 'trip-1', fare: 12000 }],
        generatedAt: Date.now(),
      };
    });

    const promises = Array.from({ length: 200 }, () =>
      cache.getOrRebuild(coldKey, 'search', loader, 60),
    );

    const results = await Promise.all(promises);

    expect(dbQueryCount).toBe(1);
    expect(loader).toHaveBeenCalledTimes(1);

    for (const res of results) {
      expect(res.trips[0].id).toBe('trip-1');
      expect(res.trips[0].fare).toBe(12000);
      expect(res.generatedAt).toBe(results[0].generatedAt);
    }

    const warmRead = await cache.getOrRebuild(coldKey, 'search', loader, 60);
    expect(dbQueryCount).toBe(1);
    expect(warmRead.trips[0].id).toBe('trip-1');
  });

  it('degrades gracefully to direct query when Redis is unavailable', async () => {
    const degradedRedis = new RedisClientService(); // uninitialized = unavailable
    const degradedMetrics = new CacheMetrics();
    const degradedCache = new CacheAsideService(degradedRedis, degradedMetrics);

    let queryCount = 0;
    const loader = async () => {
      queryCount++;
      return { answer: 'from-db' };
    };

    const res = await degradedCache.getOrRebuild(
      'int:degraded:key',
      'search',
      loader,
      60,
    );
    expect(res).toEqual({ answer: 'from-db' });
    expect(queryCount).toBe(1);
  });
});
