import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CacheAsideService } from '../../libs/common/src/cache/cache-aside.service.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
import { RouteVersionService } from '../../apps/catalog/src/modules/cache/route-version.service.js';
import { searchCacheKey } from '../../apps/catalog/src/modules/trips/trip-search-cache.js';
import { assertReachable } from './support/catalog-database.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

describe('Generational Route Versioning & Slow Rebuild Interleaving (§6.3 & §2.3 rule 2, 5)', () => {
  let redisService: RedisClientService;
  let cache: CacheAsideService;
  let routeVersion: RouteVersionService;
  let probe: Redis;

  const originStationId = '11111111-1111-4111-8111-111111111111';
  const destinationStationId = '22222222-2222-4222-8222-222222222222';
  const travelClassId = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    const url = new URL(REDIS_URL);
    await assertReachable('Redis', url.hostname, Number(url.port || 6379));

    process.env.REDIS_URL = REDIS_URL;
    redisService = new RedisClientService();
    await redisService.onModuleInit();

    cache = new CacheAsideService(redisService);
    routeVersion = new RouteVersionService(redisService);
    probe = new Redis(REDIS_URL);
  });

  afterAll(async () => {
    if (probe !== undefined) probe.disconnect();
    if (redisService !== undefined) await redisService.onModuleDestroy();
  });

  it('invalidates 100 search combinations in O(1) via route version without KEYS', async () => {
    const v1 = await routeVersion.getRouteVersion(originStationId, destinationStationId);

    // Populate 100 distinct date keys for this route under version v1
    for (let day = 1; day <= 100; day++) {
      const date = `2026-06-${String(day).padStart(2, '0')}`;
      const key = searchCacheKey({
        originStationId,
        destinationStationId,
        serviceDate: date,
        travelClassId,
        trainNumber: null,
        routeVersion: v1,
      });
      await cache.set(key, [{ tripId: `trip-${day}`, farePiastres: 10000 }], 300);
    }

    // Verify key 50 is warm
    const key50v1 = searchCacheKey({
      originStationId,
      destinationStationId,
      serviceDate: '2026-06-50',
      travelClassId,
      trainNumber: null,
      routeVersion: v1,
    });
    expect(await cache.get(key50v1)).not.toBeNull();

    // Now increment route version (O(1) invalidation)
    const v2 = await routeVersion.incrementRouteVersion(originStationId, destinationStationId);
    expect(v2).toBe(v1 + 1);

    // Subsequent search for key 50 using current route version (v2) is a cold miss!
    const key50v2 = searchCacheKey({
      originStationId,
      destinationStationId,
      serviceDate: '2026-06-50',
      travelClassId,
      trainNumber: null,
      routeVersion: v2,
    });
    expect(await cache.get(key50v2)).toBeNull();

    // Unrelated route remains intact!
    const otherOrigin = '99999999-9999-4999-8999-999999999999';
    const otherKey = searchCacheKey({
      originStationId: otherOrigin,
      destinationStationId,
      serviceDate: '2026-06-01',
      travelClassId,
      trainNumber: null,
      routeVersion: 1,
    });
    await cache.set(otherKey, [{ tripId: 'unrelated' }], 300);
    expect(await cache.get(otherKey)).toEqual([{ tripId: 'unrelated' }]);
  });

  it('guarantees slow rebuild interleaving does not poison the new route version', async () => {
    // 1. Rebuild starts: captures version V_start
    const vStart = await routeVersion.getRouteVersion(originStationId, destinationStationId);

    // 2. Database query happens in background (returns stale fare 10000)
    const staleData = [{ tripId: 'trip-slow', farePiastres: 10000 }];

    // 3. Invalidation event arrives during the 50ms window! Fare changed to 15000!
    const vNew = await routeVersion.incrementRouteVersion(originStationId, destinationStationId);
    expect(vNew).toBeGreaterThan(vStart);

    // 4. Slow rebuild completes and writes under captured vStart
    const staleKey = searchCacheKey({
      originStationId,
      destinationStationId,
      serviceDate: '2026-06-15',
      travelClassId,
      trainNumber: null,
      routeVersion: vStart,
    });
    await cache.set(staleKey, staleData, 300);

    // 5. Traveller searches now: queries current version vNew
    const freshKey = searchCacheKey({
      originStationId,
      destinationStationId,
      serviceDate: '2026-06-15',
      travelClassId,
      trainNumber: null,
      routeVersion: vNew,
    });

    // The fresh search MUST be a miss, NOT reading staleData!
    const result = await cache.get(freshKey);
    expect(result).toBeNull();
  });
});

