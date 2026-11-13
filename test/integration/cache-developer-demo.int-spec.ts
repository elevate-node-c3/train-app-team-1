import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CacheAsideService } from '../../libs/common/src/cache/cache-aside.service.js';
import { CacheMetrics } from '../../libs/common/src/cache/cache-metrics.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
import { RedisHealthService } from '../../libs/common/src/health/redis-health.service.js';
import { HealthService } from '../../libs/common/src/health/health.service.js';
import { GracefulShutdownService } from '../../libs/common/src/shutdown/graceful-shutdown.service.js';
import { RouteVersionService } from '../../apps/catalog/src/modules/cache/route-version.service.js';
import { searchCacheKey } from '../../apps/catalog/src/modules/trips/trip-search-cache.js';
import { CacheInvalidationConsumer } from '../../apps/catalog/src/modules/invalidation/cache-invalidation.consumer.js';
import { EVENT_TYPES } from '../../libs/contracts/src/events/event-types.js';
import { assertReachable } from './support/catalog-database.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

describe('Developer Flow & Demo Verification Suite (Story TA-19)', () => {
  let redisService: RedisClientService;
  let cache: CacheAsideService;
  let metrics: CacheMetrics;
  let routeVersion: RouteVersionService;
  let invalidationConsumer: CacheInvalidationConsumer;
  let healthService: HealthService;
  let redisHealthService: RedisHealthService;
  let shutdownService: GracefulShutdownService;

  const originStationId = '00000003-0000-4000-8000-000000000001'; // Ramses (Cairo)
  const destinationStationId = '00000003-0000-4000-8000-000000000004'; // Sidi Gaber (Alexandria)
  const tomorrow = '2026-06-21';
  const travelClassId = '00000005-0000-4000-8000-000000000001'; // First Class AC

  // Fake Postgres state.
  let dbFarePiastres = 15000; // 150.00 EGP
  let dbQueryCount = 0;

  const queryPostgresForTrips = vi.fn(async () => {
    dbQueryCount++;
    return [
      {
        tripId: 'trip-cairo-alex-001',
        trainNumber: '903',
        departureTime: '06:00',
        arrivalTime: '08:30',
        farePiastres: dbFarePiastres,
        availableSeats: 42,
      },
    ];
  });

  async function executeSearch(): Promise<{ trips: any[] }> {
    const version = await routeVersion.getRouteVersion(
      originStationId,
      destinationStationId,
    );
    const key = searchCacheKey({
      originStationId,
      destinationStationId,
      serviceDate: tomorrow,
      travelClassId,
      trainNumber: null,
      routeVersion: version,
    });

    const trips = await cache.getOrRebuild(
      key,
      'search',
      () => queryPostgresForTrips(),
      300,
    );

    return { trips };
  }

  beforeAll(async () => {
    const url = new URL(REDIS_URL);
    await assertReachable('Redis', url.hostname, Number(url.port || 6379));

    process.env.REDIS_URL = REDIS_URL;
    redisService = new RedisClientService();
    await redisService.onModuleInit();
    await redisService.getClient()?.flushall();

    metrics = new CacheMetrics(redisService);
    metrics.reset();

    cache = new CacheAsideService(redisService, metrics);
    routeVersion = new RouteVersionService(redisService);

    invalidationConsumer = new CacheInvalidationConsumer(
      routeVersion,
      {} as any,
      {} as any,
      cache,
    );

    shutdownService = new GracefulShutdownService();
    redisHealthService = new RedisHealthService(redisService);
    healthService = new HealthService(shutdownService, redisHealthService);
  });

  afterAll(async () => {
    if (redisService !== undefined) {
      await redisService.onModuleDestroy();
    }
  });

  it('Step 1: Search Cairo → Alexandria for tomorrow, First Class AC (cold, built from Postgres, written to Redis)', async () => {
    dbFarePiastres = 15000;
    dbQueryCount = 0;
    queryPostgresForTrips.mockClear();

    const { trips } = await executeSearch();

    expect(trips).toHaveLength(1);
    expect(trips[0].farePiastres).toBe(15000);
    expect(dbQueryCount).toBe(1);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.search.misses).toBe(1);
    expect(snapshot.search.hits).toBe(0);
  });

  it('Step 2: Search it again (warm, no database query at all)', async () => {
    const initialDbQueries = dbQueryCount;

    const { trips } = await executeSearch();

    expect(trips).toHaveLength(1);
    expect(trips[0].farePiastres).toBe(15000);
    expect(dbQueryCount).toBe(initialDbQueries);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.search.hits).toBe(1);
    expect(snapshot.search.misses).toBe(1);
    expect(snapshot.search.hitRate).toBe(0.5);
  });

  it('Step 3: Change fare through OPS-1 (the next search returns the new fare without waiting for TTL)', async () => {
    dbFarePiastres = 17500; // 175.00 EGP

    await invalidationConsumer.handle({
      id: 'evt-fare-change-123',
      type: EVENT_TYPES.fareChanged,
      occurredAt: new Date().toISOString(),
      source: 'ops',
      version: 1,
      correlationId: 'corr-demo-1',
      payload: {
        fareId: 'fare-cairo-alex-1',
        originStationId,
        destinationStationId,
        travelClassId,
        newFareMinor: 17500,
      },
    });

    // The bumped route version makes the next search miss.
    const { trips } = await executeSearch();

    expect(trips).toHaveLength(1);
    expect(trips[0].farePiastres).toBe(17500);

    const warmTrips = await executeSearch();
    expect(warmTrips.trips[0].farePiastres).toBe(17500);
  });

  it('Step 4: Fire 200 identical searches at a cold key at once (database rebuilds it once)', async () => {
    // Use a different pair to keep the key cold.
    const coldOrigin = '00000003-0000-4000-8000-000000000002';
    const coldDest = '00000003-0000-4000-8000-000000000004';
    let coldRebuilds = 0;

    const coldRebuildFn = async () => {
      coldRebuilds++;
      await new Promise((resolve) => setTimeout(resolve, 50)); // simulate DB query latency
      return [{ tripId: 'trip-cold-001', farePiastres: 12000 }];
    };

    const version = await routeVersion.getRouteVersion(coldOrigin, coldDest);
    const coldKey = searchCacheKey({
      originStationId: coldOrigin,
      destinationStationId: coldDest,
      serviceDate: tomorrow,
      travelClassId,
      trainNumber: null,
      routeVersion: version,
    });

    const promises = Array.from({ length: 200 }, () =>
      cache.getOrRebuild(coldKey, 'search', coldRebuildFn, 300),
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(200);
    for (const res of results) {
      expect(res[0].tripId).toBe('trip-cold-001');
    }

    expect(coldRebuilds).toBe(1);
  });

  it('Step 5: Redis disconnected (searches still answer slower, health check says degraded)', async () => {
    const privRedis = redisService as unknown as {
      handleConnectionError: (err: Error) => void;
    };
    privRedis.handleConnectionError(new Error('ECONNREFUSED'));

    // Redis loss degrades readiness instead of returning HTTP 503.
    const health = await healthService.checkReadiness('catalog');
    expect(health.status).toBe('degraded');
    expect(health.dependencies.redis.status).toBe('degraded');

    dbFarePiastres = 18000;
    const fallbackTrips = await cache.getOrRebuild(
      'some:degraded:key',
      'search',
      () => queryPostgresForTrips(),
      300,
    );

    expect(fallbackTrips).toHaveLength(1);
    expect(fallbackTrips[0].farePiastres).toBe(18000);
  });

  it('Step 6: Redis reconnected (cache used again without restart)', async () => {
    const privRedis = redisService as unknown as {
      handleConnectionReady: () => void;
    };
    privRedis.handleConnectionReady();

    const testKey = 'catalog:reconnect-test:v1';
    await cache.set(testKey, { reconnected: true }, 60, 'search');
    const cached = await cache.get<{ reconnected: boolean }>(testKey, 'search');
    expect(cached?.reconnected).toBe(true);

    const health = await healthService.checkReadiness('catalog');
    expect(health.status).toBe('ready');
    expect(health.dependencies.redis.status).toBe('ready');
  });

  it('Step 7: Show search cache hit rate (real counters per family)', async () => {
    const snapshot = await metrics.getSnapshotAsync();

    expect(snapshot.search).toBeDefined();
    expect(snapshot.search.total).toBeGreaterThan(0);
    expect(snapshot.search.hitRate).toBeGreaterThanOrEqual(0);
    expect(snapshot.search.hitRate).toBeLessThanOrEqual(1);

    expect(snapshot.overall).toBeDefined();
    expect(snapshot.overall.total).toBeGreaterThan(0);

    console.log('\n--- Cache Hit Rate Report (§2.3 rule 8) ---');
    console.log(
      `Search Hit Rate: ${(snapshot.search.hitRate * 100).toFixed(2)}% (Hits: ${snapshot.search.hits}, Misses: ${snapshot.search.misses}, Total: ${snapshot.search.total})`,
    );
    console.log(
      `Trip Stops Hit Rate: ${(snapshot['trip-stops'].hitRate * 100).toFixed(2)}%`,
    );
    console.log(
      `Stations Hit Rate: ${(snapshot.stations.hitRate * 100).toFixed(2)}%`,
    );
    console.log(
      `Overall Hit Rate: ${(snapshot.overall.hitRate * 100).toFixed(2)}%`,
    );
    console.log('-------------------------------------------\n');
  });
});
